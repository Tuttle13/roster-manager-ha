"""Pure scheduling maths for the automatic Friday capture (no I/O, so it's unit-testable).

The roster is published on a known Friday afternoon and every 28 days after. Each publication
covers the 28-day period starting `offset_start` days later. On publication day the app makes its
first attempt at a jittered time in a 1-hour window, then retries every `retry_minutes` until it
succeeds, pausing overnight, giving up after `give_up_days`.
"""

from datetime import date, datetime, timedelta
import hashlib

CYCLE_DAYS = 28


def _d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def jitter_seconds(cycle_iso, window_seconds=3600):
    """Deterministic 'random' offset into the first-attempt window, stable across restarts."""
    h = hashlib.sha1(cycle_iso.encode()).digest()
    return int.from_bytes(h[:4], "big") % window_seconds


def current_cycle(now, anchor_publish, offset_start=10):
    """The most recent publication on/before now (>= anchor). Returns dict or None."""
    a = _d(anchor_publish)
    nd = now.date()
    if nd < a:
        return None
    k = (nd - a).days // CYCLE_DAYS
    pub = a + timedelta(days=k * CYCLE_DAYS)
    start = pub + timedelta(days=offset_start)
    return {
        "cycle": pub.isoformat(),
        "publish": pub.isoformat(),
        "period": {"start": start.isoformat(), "end": (start + timedelta(days=CYCLE_DAYS - 1)).isoformat()},
    }


def next_publication(now, anchor_publish, offset_start=10):
    a = _d(anchor_publish)
    nd = now.date()
    k = max(0, (nd - a).days // CYCLE_DAYS + (1 if nd >= a else 0))
    if nd < a:
        k = 0
    pub = a + timedelta(days=k * CYCLE_DAYS)
    if pub <= nd and now.date() >= a:
        pub = pub + timedelta(days=CYCLE_DAYS)
    start = pub + timedelta(days=offset_start)
    return {"publish": pub.isoformat(), "period": {"start": start.isoformat(), "end": (start + timedelta(days=CYCLE_DAYS - 1)).isoformat()}}


def first_attempt_at(cycle_iso, start_hour=15, window_seconds=3600):
    pub = _d(cycle_iso)
    base = datetime(pub.year, pub.month, pub.day, start_hour, 0, 0)
    return base + timedelta(seconds=jitter_seconds(cycle_iso, window_seconds))


def decide(now, settings, state):
    """What the scheduler should do right now.

    settings keys: autoEnabled, autoAnchorPublish, autoOffsetStart, autoStartHour,
      retryMinutes, nightPauseFrom, nightResume, giveUpDays.
    state (persisted): { cycle, status('done'|'failed'|'retrying'|None), nextAttemptAt(iso|None) }

    Returns (action, info):
      ('sleep', seconds)                 nothing to do yet
      ('run', {cycle, period})           attempt a capture now
      ('done', None)                     this cycle is finished; wait for the next one
    """
    if not settings.get("autoEnabled"):
        return ("sleep", 3600)
    anchor = settings.get("autoAnchorPublish")
    if not anchor:
        return ("sleep", 3600)
    offset = int(settings.get("autoOffsetStart", 10))
    cyc = current_cycle(now, anchor, offset)
    if not cyc:
        return ("sleep", 3600)
    cycle = cyc["cycle"]

    # A finished cycle (captured, or given up) is left alone until the next publication.
    if state.get("cycle") == cycle and state.get("status") in ("done", "failed"):
        return ("done", None)

    start_hour = int(settings.get("autoStartHour", 15))
    first = first_attempt_at(cycle, start_hour)
    if now < first:
        return ("sleep", min(3600, max(5, (first - now).total_seconds())))

    # Give up once the roster is older than giveUpDays since publication.
    give_up_days = int(settings.get("giveUpDays", 3))
    if now.date() > _d(cycle) + timedelta(days=give_up_days):
        return ("done", None)

    # Overnight pause.
    pause_from = int(settings.get("nightPauseFrom", 23))
    resume = int(settings.get("nightResume", 7))
    if _in_night(now.hour, pause_from, resume):
        return ("sleep", _seconds_to_resume(now, resume))

    # Respect a pending retry time.
    nxt = state.get("nextAttemptAt")
    if state.get("cycle") == cycle and nxt:
        nd = datetime.fromisoformat(nxt)
        if now < nd:
            return ("sleep", min(600, max(5, (nd - now).total_seconds())))

    return ("run", {"cycle": cycle, "period": cyc["period"]})


def _in_night(hour, pause_from, resume):
    if pause_from == resume:
        return False
    if pause_from < resume:
        return pause_from <= hour < resume
    return hour >= pause_from or hour < resume


def _seconds_to_resume(now, resume):
    target = now.replace(hour=resume, minute=0, second=0, microsecond=0)
    if now.hour >= resume:
        target = target + timedelta(days=1)
    return max(5, min(3600, (target - now).total_seconds()))


RETRYABLE = ("didn't respond", "did not respond", "didn't show the roster", "within 2 minutes",
             "couldn't reach", "could not reach", "overloaded", "too many", "try again later",
             "no-duties", "not yet", "not published", "empty", "timed out", "unavailable",
             "temporarily", "503", "502", "500", "network")


def is_retryable(reason):
    r = (reason or "").lower()
    return any(w in r for w in RETRYABLE)
