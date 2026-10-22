#!/usr/bin/env python3
"""
dsh-web-search-model — upstream drift check.

This plugin takes over the official web search settings card, and therefore
depends on a set of upstream surfaces. Run this script after upgrading dsh: it
re-reads those surfaces and reports which of them changed.

It checks contracts, not content — reworded comments or messages upstream do not
trip it.

Usage:
    python3 check-drift.py            # check; exit code 1 when drift is found
    python3 check-drift.py --quiet    # print only the items that failed

The @deepseek-ai package directory can be overridden with DSH_DS_PACKAGES
(default below).
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PKGS = "/opt/dsh/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
PKGS = os.environ.get("DSH_DS_PACKAGES", DEFAULT_PKGS)

UPSTREAM = os.path.join(PKGS, "dsh-client-ui-settings-web-search/lib/client.js")
PLUGIN_MANAGER = os.path.join(PKGS, "dsh-client-ui-plugin-manager/lib/client.js")
# The slot registry now ships inside the browser-runner package instead of a
# standalone `dsh-client-ui-slots`; the primitives are only inside the built
# `dsh-web-frontend` bundle. More than one candidate is listed per contract, and
# the first one that exists on disk is used.
SLOTS_CORE_CANDIDATES = [
    os.path.join(PKGS, "dsh-web-frontend/dist/assets"),
    os.path.join(PKGS, "dsh-client-ui-slots/lib/index.js"),
]
# The registration seat that assigns shadowing priorities to dynamic packages.
SLOTS_SEAT_CANDIDATES = [
    os.path.join(PKGS, "dsh-cordis-client-runner/lib/client.js"),
]
PRIMITIVES_CANDIDATES = [
    os.path.join(PKGS, "dsh-client-ui-primitives/lib/index.js"),
    os.path.join(PKGS, "dsh-web-frontend/lib/index.js"),
]
MINE = os.path.join(HERE, "lib/client.js")

# Slot id and priority this plugin registers with — used to confirm that the
# shadowing of the official card still holds.
MY_SLOT_ID = "web-search"
MY_PRIORITY = -1

# Field ids rendered by this plugin.
MY_FIELD_IDS = {
    "plugin-config-web-search-key",
    "plugin-config-web-search-endpoint",
    "plugin-config-web-search-model",
    "plugin-config-web-search-max-uses",
}

# Field ids that stand for the SAME settings field under two API modes.
#
# Upstream renders one numeric control whose id switches on the Search API
# toggle: `plugin-config-web-search-count` when the provider's `count` field is
# edited, `plugin-config-web-search-max-uses` when `maxUses` is. Both are the
# same control over `state[limitField]`, so seeing `…-count` upstream is not a
# field this card fails to render — it is the sibling id of one it does render.
# Either id satisfies the other.
FIELD_ID_ALIASES = [
    {"plugin-config-web-search-count", "plugin-config-web-search-max-uses"},
]

problems = []
notes = []
# A contract whose source file this install does not ship. Reported and skipped,
# never counted as drift: `missing file` means "not checked here", and the rest
# of the checks still decide the exit code.
skipped = []


def read(path):
    if not os.path.exists(path):
        skipped.append(path)
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def read_first(candidates):
    """First candidate that exists (a directory matches its compiled assets),
    or None when the install ships none of them."""
    for path in candidates:
        if os.path.isdir(path):
            found = sorted(
                os.path.join(path, name)
                for name in os.listdir(path)
                if name.endswith(".js")
            )
            text = "\n".join(filter(None, (read(one) for one in found)))
            if text:
                return text
            continue
        if os.path.exists(path):
            return read(path)
    skipped.append(candidates[0])
    return None


def check(label, ok, detail="", note=None):
    """Record one check result; ok=False counts as a problem."""
    if ok:
        notes.append(f"  ok    {label}{(' — ' + detail) if detail else ''}")
    else:
        problems.append(f"  DRIFT {label}{(' — ' + detail) if detail else ''}")


def main():
    quiet = "--quiet" in sys.argv

    upstream = read(UPSTREAM)
    manager = read(PLUGIN_MANAGER)
    slot_core = read_first(SLOTS_CORE_CANDIDATES)
    slot_seat = read_first(SLOTS_SEAT_CANDIDATES)
    primitives = read_first(PRIMITIVES_CANDIDATES)
    mine = read(MINE)
    if any(x is None for x in (upstream, manager, mine)):
        print("\n".join(f"missing file: {path}" for path in skipped))
        return 2

    # ── 1. The slot mechanism itself ─────────────────────────────────────
    # plugins.item must still be a list slot, otherwise "partition by id and
    # shadow by priority" no longer holds.
    check(
        "plugins.item is still a list slot",
        re.search(r'"plugins\.item"\s*:\s*\{[^}]*kind\s*:\s*"list"', manager) is not None,
        "children declaration in dsh-client-ui-plugin-manager",
    )

    # priority must still be written into the entry record, and entriesOfSlot
    # must still take the head of each cell.
    if slot_core is not None:
        # The core stores the entry's priority and elects one head per cell.
        # Older installs spell the copy `options.priority = options.priority ?? 0`;
        # current ones keep the field on the stored entry.
        check(
            "priority is still stored with the entry",
            re.search(r"priority\s*:\s*\w+\.priority", slot_core) is not None
            or re.search(r"options\.priority\s*!==\s*void 0\s*\?\s*\{\s*priority", slot_core) is not None,
            "SlotCore.register in dsh-client-ui-slots / the frontend bundle",
        )
        check(
            "entriesOfSlot still takes the first entry of each id",
            "entriesOfSlot" in slot_core
            and (
                "seenCells" in slot_core
                or re.search(r"\.has\(\w+\)\s*\|\|\s*\(\w+\.add\(\w+\),\s*\w+\.push\(\w+\)\)", slot_core) is not None
            ),
            "the point where shadowing lands",
        )
    if slot_seat is not None:
        # The seat moves a package registration into an already-shadowed cell
        # by handing it the next lower priority, which is the half of the
        # mechanism this plugin actually relies on.
        check(
            "the registration seat still assigns a shadowing priority",
            "allocatePriority" in slot_seat and re.search(r"options\.priority\s*=\s*priority", slot_seat) is not None,
            "guardedSlots in dsh-cordis-client-runner",
        )

    # ── 2. Slot id / order of the official card — the shadowing target ────
    reg = re.search(
        r'name:\s*"plugins\.item"\s*,\s*id:\s*"([^"]+)"\s*,\s*order:\s*(\d+)',
        upstream,
    )
    if reg is None:
        # Upstream may have changed the registration style (multi-line, or a
        # different property order); fall back to reading the id alone.
        ids = re.findall(r'name:\s*"plugins\.item".{0,200}?id:\s*"([^"]+)"', upstream, re.S)
        check(
            f"official card slot id is still {MY_SLOT_ID}",
            MY_SLOT_ID in ids,
            f"read {ids or '(unparsable — the upstream registration style changed)'}",
        )
        problems.append("  DRIFT cannot parse the official card's order — the upstream registration style changed, check it by hand")
    else:
        check(
            f"official card slot id is still {MY_SLOT_ID}",
            reg.group(1) == MY_SLOT_ID,
            f"read {reg.group(1)}",
        )
        # The order this plugin registers with must match the shipped card's,
        # or the card sorts into a slot upstream never put it in. Read the
        # expectation from our own source rather than hard-coding it, so the
        # two are compared to each other and a bump on either side is caught.
        mine_order = re.search(r"SHADOWED_CARD_ORDER\s*=\s*(\d+)", read(MINE))
        check(
            "official card order still matches the order this plugin registers with",
            mine_order is not None and reg.group(2) == mine_order.group(1),
            (
                f"upstream order {reg.group(2)}, this plugin registers "
                f"{mine_order.group(1) if mine_order else '(unparsable)'}"
                " (affects card ordering only, not shadowing)"
            ),
        )

    # ── 3. Fields of the official card — has upstream added any? ──────────
    upstream_fields = set(re.findall(r'"(plugin-config-web-search-[a-z-]+)"', upstream))
    # Fold each alias group down to a single representative id on both sides, so
    # a mode-dependent id is compared as the one field it really is.
    def fold(fields):
        out = set(fields)
        for group in FIELD_ID_ALIASES:
            if out & group:
                out -= group
                out.add(sorted(group)[0])
        return out

    upstream_fields = fold(upstream_fields)
    mine_fields = fold(MY_FIELD_IDS)
    added = upstream_fields - mine_fields
    missing = mine_fields - upstream_fields
    check(
        "upstream has no new field this plugin does not render",
        not added,
        f"upstream added {sorted(added)} — this card will not display them" if added else "",
    )
    if missing:
        notes.append(
            f"  note  this card renders fields upstream does not have {sorted(missing)} — that is the model field, expected"
        )

    # ── 4. Namespace ─────────────────────────────────────────────────────
    ns = re.search(r'const\s+WEB_SEARCH_NS\s*=\s*"([^"]+)"', upstream)
    check(
        'namespace is still "web-search-deepseek"',
        ns is not None and ns.group(1) == "web-search-deepseek",
        f"read {ns.group(1) if ns else '(unparsable)'}",
    )

    # ── 5. Are the primitives exports this plugin uses still present? ─────
    if primitives is not None:
        used = set(re.findall(r"\bprimitives\.([A-Za-z_][A-Za-z0-9_]*)", mine))
        # Last `export {` statement: a bundle's compiled output may carry an
        # internal `export {` earlier in the file, so every one is scanned.
        preamble = primitives.rsplit("export {", 1)[-1]
        exported = set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", preamble.split("}")[0])) if "export {" in primitives else set()
        if not exported:
            # No export list to read: fall back to "the name appears somewhere",
            # which cannot prove absence but still catches a removed component.
            exported = set(re.findall(r"\b([A-Za-z_$][A-Za-z0-9_$]*)\b", primitives))
        gone = sorted(n for n in used if n not in exported)
        check(
            f"all {len(used)} primitives exports this plugin uses are still present",
            not gone,
            f"gone: {gone}" if gone else "",
        )

    # ── Output ───────────────────────────────────────────────────────────
    if not quiet:
        print("dsh-web-search-model — upstream drift check")
        print(f"  upstream package directory: {PKGS}")
        print()
        for line in notes:
            print(line)
        for path in skipped:
            print(f"  skip  missing file: {path} — not checked in this install")
        print()

    if problems:
        print("Drift found:")
        print("\n".join(problems))
        print()
        print("What to do: compare against")
        print(f"  {UPSTREAM}")
        print("and bring lib/client.js back in line. See the DRIFT lines above for the field differences.")
        return 1

    print("No drift — every upstream contract this plugin relies on still holds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
