"""What happens to the lease when comms drop mid-mission.

This is the failure that killed the first HSSE run: WiFi dropped for a moment
on a 400 ft route, the lease check-in failed, and every command afterwards was
refused with LeaseUseError even though comms came straight back. The SDK
keepalive survives a failed retain, but it keeps retaining the same lease, and
a lease the robot has rejected does not become valid again by being asked
twice.

The recovery has one property that matters more than getting the robot back:
it must never take the lease off a human. A dropped packet and a tablet
operator taking over both surface as a failed check-in, and only the first is
safe to recover from.
"""

from __future__ import annotations

import threading

from unittest.mock import MagicMock

import pytest

from bosdyn.client.lease import ResourceAlreadyClaimedError


def test_check_in_failure_reacquires(controller):
    """A stale lease is replaced rather than retained forever."""
    controller._on_lease_check_in_failed(RuntimeError("comms dropped"))

    controller._clients["lease"].acquire.assert_called_once()
    assert controller.lease_health()["recoveries"] == 1


def test_recovery_never_steals_from_another_operator(controller):
    """If the tablet has taken the lease, it keeps it.

    Recovering by force here would wrest the robot away from whoever is now
    driving it, which is worse than the outage being recovered from.
    """
    controller._clients["lease"].acquire.side_effect = ResourceAlreadyClaimedError(None)

    controller._on_lease_check_in_failed(RuntimeError("lease taken"))

    health = controller.lease_health()
    assert health["surrendered_to"] == "another operator"
    assert health["recoveries"] == 0
    # take() is what would steal it back, and it must never be reached.
    controller._clients["lease"].take.assert_not_called()


def test_surrender_is_sticky(controller):
    """Once surrendered, later failures do not start grabbing at it again."""
    controller._clients["lease"].acquire.side_effect = ResourceAlreadyClaimedError(None)
    controller._on_lease_check_in_failed(RuntimeError("lease taken"))
    calls_after_surrender = controller._clients["lease"].acquire.call_count

    controller._lease_recovery["last_attempt"] = 0.0     # retry interval elapsed
    for _ in range(5):
        controller._on_lease_check_in_failed(RuntimeError("still taken"))

    assert controller._clients["lease"].acquire.call_count == calls_after_surrender
    controller._clients["lease"].take.assert_not_called()


def test_attempts_are_rate_limited(controller):
    """A long outage does not become a flood of re-acquire calls.

    The keepalive checks in every 2s, so an unthrottled recovery would fire
    fifteen times through a 30 second dropout.
    """
    for _ in range(10):
        controller._on_lease_check_in_failed(RuntimeError("comms down"))

    assert controller._clients["lease"].acquire.call_count == 1
    assert controller.lease_health()["check_in_failures"] == 10


def test_retry_resumes_after_the_interval(controller):
    """Throttling delays recovery, it does not cancel it."""
    controller._on_lease_check_in_failed(RuntimeError("comms down"))
    controller._lease_recovery["last_attempt"] -= controller.LEASE_RETRY_INTERVAL_S + 1

    controller._on_lease_check_in_failed(RuntimeError("comms down"))

    assert controller._clients["lease"].acquire.call_count == 2


def test_failed_reacquire_leaves_the_door_open(controller):
    """If the robot is still unreachable, recovery stays armed for next time."""
    controller._clients["lease"].acquire.side_effect = RuntimeError("still unreachable")

    controller._on_lease_check_in_failed(RuntimeError("comms down"))

    health = controller.lease_health()
    assert health["surrendered_to"] is None      # not a hand-over, just an outage
    assert health["recoveries"] == 0


def test_acquiring_the_lease_clears_a_previous_surrender(controller):
    """Taking control again starts from a clean slate.

    Without this a single hand-over would leave recovery switched off for the
    rest of the process, and the next mission would inherit it silently.
    """
    controller._lease_recovery["surrendered_to"] = "another operator"
    controller._reset_lease_recovery()

    assert controller.lease_health()["surrendered_to"] is None

    controller._on_lease_check_in_failed(RuntimeError("comms dropped"))
    assert controller._clients["lease"].acquire.called


def test_recovery_does_not_block_on_the_main_lock(controller):
    """The callback runs on the keepalive thread, not the caller's.

    Taking the controller's main lock there would deadlock against any API
    call already holding it, which on a moving robot means the mission hangs
    instead of recovering. The lock is an RLock, so holding it on this thread
    would prove nothing: it has to be held by a different one.
    """
    holding = threading.Event()
    release = threading.Event()

    def hold_the_lock():
        with controller._lock:
            holding.set()
            release.wait(timeout=5)

    holder = threading.Thread(target=hold_the_lock, daemon=True)
    holder.start()
    assert holding.wait(timeout=5), "helper thread never took the lock"

    done = threading.Event()

    def recover():
        controller._on_lease_check_in_failed(RuntimeError("comms dropped"))
        done.set()

    threading.Thread(target=recover, daemon=True).start()
    recovered = done.wait(timeout=5)

    release.set()
    holder.join(timeout=5)

    assert recovered, "recovery blocked on the main lock"
    assert controller._clients["lease"].acquire.called
