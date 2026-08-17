/*
 * BRIDGE SPOT — voice intent resolution and command registry.
 *
 * Speech is matched against a fixed allowlist of intents, each bound to a
 * function on RobotService. There is no path from a transcript to an arbitrary
 * API call: if the words do not resolve to an intent in this file, nothing is
 * dispatched. That is the main safety property here, and it is why resolution
 * is deterministic string matching rather than a model.
 *
 * Every intent maps onto an action the dashboard already had. Voice is another
 * way to press the same buttons — it gets no privileges the Control page
 * does not have, and the backend still enforces lease, E-stop and power.
 *
 * Exposed as window.VoiceCommands.
 */
(function (window) {
    "use strict";

    /* ------------------------------------------------------------------
       Normalisation
       ------------------------------------------------------------------ */

    // Words that carry no meaning for command matching. Stripping them lets
    // "could you please get spot to stand up now" reduce to "stand up".
    var FILLER = [
        "please", "could", "would", "can", "you", "the", "a", "now", "then",
        "just", "kindly", "for", "me", "hey", "ok", "okay", "um", "uh",
        "robot", "spot", "dog", "lets", "let", "us", "go", "ahead", "and", "i",
        "want", "need", "to", "do", "get", "make", "will", "well"
    ];

    /**
     * Lowercase, strip punctuation, collapse whitespace.
     * Kept separate from filler removal because some matches want the raw words.
     */
    function normalize(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function stripFiller(normalized) {
        var kept = normalized.split(" ").filter(function (word) {
            return word && FILLER.indexOf(word) === -1;
        });
        return kept.join(" ");
    }

    /* ------------------------------------------------------------------
       Response pools

       A small set per outcome so repeated commands do not sound like a
       recording, without turning the assistant chatty.
       ------------------------------------------------------------------ */

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    /* ------------------------------------------------------------------
       Registry

       requiresConnection : robot must be connected
       requiresControl    : E-stop registered and clear, lease held, motors on
       requiresPower      : motors on (implied by requiresControl)
       risk               : safe | caution | critical
       ------------------------------------------------------------------ */

    var COMMANDS = [
        {
            intent: "EMERGENCY_STOP",
            label: "Emergency stop",
            // Checked before everything else, and deliberately terse: a safety
            // command should not wait on a sentence of acknowledgement.
            aliases: [
                "emergency stop", "estop", "e stop", "kill", "kill it",
                "emergency", "cut power", "stop everything"
            ],
            requiresConnection: true,
            requiresControl: false,
            risk: "critical",
            run: function (svc) { return svc.engageEstop(); },
            responses: {
                acknowledgement: ["Emergency stop."],
                success: ["Motor power cut, sir."],
                failure: ["I could not engage the emergency stop, sir."]
            }
        },
        {
            intent: "STOP",
            label: "Stop",
            aliases: ["stop", "stop now", "halt", "freeze", "hold", "wait", "stand by", "stop moving"],
            requiresConnection: true,
            requiresControl: true,
            risk: "critical",
            run: function (svc) { return svc.stop(); },
            responses: {
                acknowledgement: ["Stopping now."],
                success: ["Stopped, sir."],
                failure: ["I could not stop the motion, sir. Use the hardware E-stop."]
            }
        },
        {
            intent: "CONNECT_ROBOT",
            label: "Connect",
            aliases: [
                "connect", "connect spot", "connect to spot", "connect to robot",
                "connect robot", "spot connect", "get spot connected", "link up",
                "come online", "wake up", "sign in"
            ],
            requiresConnection: false,
            requiresControl: false,
            risk: "safe",
            run: function (svc) { return svc.connect(); },
            responses: {
                acknowledgement: ["On it, sir. Connecting to Spot now.", "Connecting, sir."],
                success: ["Connected, sir. Spot is online and ready.", "We are online, sir."],
                failure: ["I couldn't establish the connection, sir. Check the robot network and credentials."]
            }
        },
        {
            intent: "DISCONNECT_ROBOT",
            label: "Disconnect",
            aliases: ["disconnect", "disconnect spot", "disconnect robot", "log out", "sign out", "go offline"],
            requiresConnection: true,
            requiresControl: false,
            risk: "safe",
            run: function (svc) { return svc.disconnect(); },
            responses: {
                acknowledgement: ["Disconnecting, sir."],
                success: ["Disconnected. Spot is offline."],
                failure: ["I couldn't disconnect cleanly, sir."]
            }
        },
        {
            intent: "REGISTER_ESTOP",
            label: "Register E-stop",
            aliases: ["register estop", "register e stop", "arm estop", "arm the estop", "set up estop", "estop register"],
            requiresConnection: true,
            requiresControl: false,
            risk: "caution",
            run: function (svc) { return svc.registerEstop(); },
            responses: {
                acknowledgement: ["Registering the E-stop, sir."],
                success: ["E-stop registered and holding."],
                failure: ["I couldn't register the E-stop, sir."]
            }
        },
        {
            intent: "ACQUIRE_LEASE",
            label: "Acquire lease",
            aliases: ["acquire lease", "take lease", "take the lease", "get lease", "grab the lease", "lease"],
            requiresConnection: true,
            requiresControl: false,
            risk: "caution",
            run: function (svc) { return svc.acquireLease(); },
            responses: {
                acknowledgement: ["Taking the body lease, sir."],
                success: ["Lease acquired. I have control."],
                failure: ["I couldn't take the lease, sir. Another operator may still hold it."]
            }
        },
        {
            intent: "POWER_ON",
            label: "Power on",
            aliases: ["power on", "power up", "turn on", "motors on", "power the motors on", "switch on", "energise"],
            requiresConnection: true,
            requiresControl: false,
            risk: "caution",
            run: function (svc) { return svc.powerOn(); },
            responses: {
                acknowledgement: ["Powering Spot on, sir."],
                success: ["Power is on. Systems are ready.", "Motors are live, sir."],
                failure: ["Power-up failed, sir. Check the E-stop and lease."]
            }
        },
        {
            intent: "POWER_OFF",
            label: "Power off",
            aliases: ["power off", "power down", "turn off", "motors off", "shut down", "switch off"],
            requiresConnection: true,
            requiresControl: false,
            risk: "caution",
            run: function (svc) { return svc.powerOff(); },
            responses: {
                acknowledgement: ["Powering down, sir."],
                success: ["Power is off. Spot is safe."],
                failure: ["I couldn't power down, sir."]
            }
        },
        {
            intent: "STAND",
            label: "Stand",
            aliases: ["stand", "stand up", "get up", "up", "rise", "on your feet", "stand tall"],
            requiresConnection: true,
            requiresControl: true,
            risk: "caution",
            run: function (svc) { return svc.stand(); },
            responses: {
                acknowledgement: [
                    "On it, sir. I'll be standing right away.",
                    "Certainly, sir. Standing now.",
                    "Understood. Getting up now, sir."
                ],
                success: ["I'm up, sir. Ready when you are.", "Standing and ready.", "I'm on my feet, sir."],
                failure: ["I couldn't stand, sir."]
            }
        },
        {
            intent: "SIT",
            label: "Sit",
            aliases: ["sit", "sit down", "down", "lie down", "take a seat", "rest"],
            requiresConnection: true,
            requiresControl: true,
            risk: "caution",
            run: function (svc) { return svc.sit(); },
            responses: {
                acknowledgement: ["Certainly, sir. Sitting down now.", "Sitting, sir."],
                success: ["Seated and stable.", "Down and settled, sir."],
                failure: ["I couldn't sit down, sir."]
            }
        },
        {
            intent: "SELF_RIGHT",
            label: "Self-right",
            aliases: ["self right", "selfright", "right yourself", "roll over", "get back up", "recover"],
            requiresConnection: true,
            requiresControl: true,
            risk: "caution",
            run: function (svc) { return svc.selfRight(); },
            responses: {
                acknowledgement: ["Righting myself, sir."],
                success: ["Back upright, sir."],
                failure: ["I couldn't self-right, sir."]
            }
        },
        {
            intent: "DOCK",
            label: "Dock",
            aliases: ["dock", "go dock", "return to dock", "go home", "go to the dock", "charge", "go charge"],
            requiresConnection: true,
            requiresControl: true,
            risk: "caution",
            run: function (svc) { return svc.dock(); },
            responses: {
                acknowledgement: ["Understood, sir. Beginning the docking sequence."],
                success: ["Docking complete.", "On the dock and charging, sir."],
                failure: ["Docking failed, sir."]
            }
        },
        {
            intent: "UNDOCK",
            label: "Undock",
            aliases: ["undock", "leave the dock", "off the dock", "get off the dock", "release from dock"],
            requiresConnection: true,
            requiresControl: true,
            risk: "caution",
            run: function (svc) { return svc.undock(); },
            responses: {
                acknowledgement: ["Undocking now, sir."],
                success: ["Clear of the dock, sir."],
                failure: ["I couldn't undock, sir."]
            }
        },
        {
            intent: "ROBOT_STATUS",
            label: "Status",
            aliases: ["status", "report", "status report", "how are you", "sitrep", "diagnostics", "systems check", "battery"],
            requiresConnection: false,
            requiresControl: false,
            risk: "safe",
            // Read-only: the spoken reply is built from live telemetry by the
            // controller, so there is no canned success line here.
            run: function (svc) { return svc.getState(); },
            responses: {
                acknowledgement: ["Checking, sir."],
                success: ["Status reported."],
                failure: ["I couldn't read the robot state, sir."]
            }
        }
    ];

    var BY_INTENT = {};
    COMMANDS.forEach(function (c) { BY_INTENT[c.intent] = c; });

    /* ------------------------------------------------------------------
       Resolution

       Longest alias wins, so "stop everything" beats "stop" and
       "power off" is never mistaken for "power on".
       ------------------------------------------------------------------ */

    function matchesAlias(haystack, alias) {
        if (haystack === alias) return alias.length + 100;   // exact wins outright
        // Word-boundary containment, so "sit" does not match "visitor".
        var pattern = new RegExp("(^|\\s)" + alias.replace(/\s+/g, "\\s+") + "($|\\s)");
        return pattern.test(haystack) ? alias.length : 0;
    }

    /**
     * Resolve a transcript to a command.
     * @returns {{command: Object, score: number, matched: string}|null}
     */
    function resolve(transcript) {
        var normalized = normalize(transcript);
        if (!normalized) return null;
        var stripped = stripFiller(normalized);

        var best = null;

        COMMANDS.forEach(function (command) {
            command.aliases.forEach(function (alias) {
                // Try both forms: filler removal helps long sentences but can
                // over-trim short ones ("get up" -> "up").
                var score = Math.max(
                    matchesAlias(normalized, alias),
                    stripped ? matchesAlias(stripped, alias) : 0
                );
                if (score > 0 && (!best || score > best.score)) {
                    best = { command: command, score: score, matched: alias };
                }
            });
        });

        return best;
    }

    window.VoiceCommands = {
        normalize: normalize,
        stripFiller: stripFiller,
        resolve: resolve,
        pick: pick,
        all: COMMANDS,
        byIntent: function (intent) { return BY_INTENT[intent] || null; },
        intents: COMMANDS.map(function (c) { return c.intent; })
    };
})(window);
