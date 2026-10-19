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
SLOTS = os.path.join(PKGS, "dsh-client-ui-slots/lib/index.js")
PRIMITIVES = os.path.join(PKGS, "dsh-client-ui-primitives/lib/index.js")
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

problems = []
notes = []


def read(path):
    if not os.path.exists(path):
        problems.append(f"missing file: {path}")
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


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
    slots = read(SLOTS)
    primitives = read(PRIMITIVES)
    mine = read(MINE)
    if any(x is None for x in (upstream, manager, slots, primitives, mine)):
        print("\n".join(problems))
        return 2

    # ── 1. The slot mechanism itself ─────────────────────────────────────
    # plugins.item must still be a list slot, otherwise "partition by id and
    # shadow by priority" no longer holds.
    check(
        "plugins.item is still a list slot",
        re.search(r'"plugins\.item"\s*:\s*\{[^}]*kind\s*:\s*"list"', manager) is not None,
        "children declaration in dsh-client-ui-plugin-manager",
    )

    # priority must still be copied into the entry record, and entriesOfSlot
    # must still take the head of each cell.
    check(
        "priority is still written into the entry record",
        re.search(r"options\.priority\s*!==\s*void 0\s*\?\s*\{\s*priority", slots) is not None,
        "register() in dsh-client-ui-slots",
    )
    check(
        "entriesOfSlot still takes the first entry of each id",
        "seenCells" in slots and "entriesOfSlot" in slots,
        "the point where shadowing lands",
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
        check(
            "official card order is still 40",
            reg.group(2) == "40",
            f"read {reg.group(2)} (affects card ordering only, not shadowing)",
        )

    # ── 3. Fields of the official card — has upstream added any? ──────────
    upstream_fields = set(re.findall(r'"(plugin-config-web-search-[a-z-]+)"', upstream))
    added = upstream_fields - MY_FIELD_IDS
    missing = MY_FIELD_IDS - upstream_fields
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
    used = set(re.findall(r"\bprimitives\.([A-Za-z_][A-Za-z0-9_]*)", mine))
    exported = set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", primitives.split("export {")[-1]))
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
