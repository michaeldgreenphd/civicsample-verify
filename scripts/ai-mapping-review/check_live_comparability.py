"""Offline comparison of answer-free displayed task snapshots. No database or provider access.

The live snapshot must be captured by the investigator from the deployed renderer,
not reconstructed by substituting the AI input or a preparation manifest. Only
counts, booleans and guide hashes may leave this command. Per-unit covariates are
returned by compare() for a private, post-closure analysis consumer.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import runner as R

FORMAT = 'civicsample-ai-live-comparability-1.0'
DISPLAY_FIELDS = ('title', 'question', 'assertion', 'polarity', 'context', 'basis',
                  'decision', 'note', 'parent_row_label')


def read_private(value: str, digest: str) -> bytes:
    path = Path(value)
    R.require(path.is_absolute() and path.is_file(), 'unsafe_input')
    R.require(not any(p.is_symlink() for p in (path, *path.parents)), 'unsafe_input')
    R.require(not any((p / '.git').exists() for p in path.parents), 'private_input_required')
    R.require(isinstance(digest, str) and R.HEX.fullmatch(digest), 'input_digest_mismatch')
    raw = path.read_bytes()
    R.require(R.sha(raw) == digest, 'input_digest_mismatch')
    return raw


def validate_live(raw: bytes, digest: str) -> dict:
    R.require(len(raw) <= 50_000_000 and R.sha(raw) == digest, 'input_digest_mismatch')
    live = R.keys(R.decode(raw), {'format', 'captured_at', 'app_commit', 'renderer_revision_verified', 'freeze', 'guide', 'units'})
    R.require(live['format'] == FORMAT, 'invalid_snapshot')
    R.require(live['renderer_revision_verified'] is True, 'deployed_renderer_unverified')
    R.text(live['captured_at'], 100)
    # ISO timestamps with an explicit timezone are required; a file date is not
    # evidence of the deployed app revision or of the date of observation.
    from datetime import datetime
    try:
        captured = datetime.fromisoformat(live['captured_at'].replace('Z', '+00:00'))
        R.require(captured.tzinfo is not None, 'invalid_snapshot')
    except ValueError:
        raise R.Refused('invalid_snapshot') from None
    R.keys(live['freeze'], {'unit_list_sha256', 'import_sha256'})
    candidate = {'format': R.FORMAT, 'guide': live['guide'], 'units': copy.deepcopy(live['units']),
                 'source': {'app_commit': live['app_commit'],
                            'sample_sha256': live['freeze']['unit_list_sha256'],
                            'prepared_import_sha256': live['freeze']['import_sha256']}}
    # The live UI may reorder the same three options. Validate the vocabulary in
    # canonical order but retain the observed order for the difference count.
    R.require(isinstance(candidate['units'], list), 'invalid_snapshot')
    for u in candidate['units']:
        stored_hash = u.pop('stored_packet_sha256', None) if isinstance(u, dict) else None
        R.require(isinstance(stored_hash, str) and R.HEX.fullmatch(stored_hash), 'stored_packet_hash_required')
        options = u.get('answer_options') if isinstance(u, dict) else None
        R.require(isinstance(options, list) and all(isinstance(o, dict) and o.get('code') in R.ANSWERS for o in options),
                  'invalid_snapshot')
        u['answer_options'] = sorted(options, key=lambda o: R.ANSWERS.index(o['code']))
    candidate_raw = R.encode(candidate)
    R.validate_bundle(candidate_raw, R.sha(candidate_raw))
    R.require(all(re.fullmatch(r'[A-Za-z0-9_-]+', u['unit_id']) for u in live['units']), 'invalid_unit_key')
    R.require(all(re.fullmatch(r'[A-Z0-9_]+', u['packet']['unit']['category']) for u in live['units']), 'invalid_category_key')
    return live


def compare(ai: dict, live: dict) -> tuple[dict, list[dict]]:
    """Both arguments are validated again; never match units by position."""
    raw = R.encode(ai)
    R.validate_bundle(raw, R.sha(raw))
    R.require(all(re.fullmatch(r'[A-Z0-9_]+', u['packet']['unit']['category']) for u in ai['units']), 'invalid_category_key')
    raw = R.encode(live)
    validate_live(raw, R.sha(raw))
    ai_units = {u['unit_id']: u for u in ai['units']}
    live_units = {u['unit_id']: u for u in live['units']}
    R.require(ai_units.keys() == live_units.keys(), 'sample_units_differ')
    counts = {field: 0 for field in DISPLAY_FIELDS}
    counts.update(response_options=0, reason_codes=0, subtype_required=0)
    rows = []
    for uid, unit in ai_units.items():
        current = live_units[uid]
        changed = {field: unit['display'].get(field) != current['display'].get(field)
                   for field in DISPLAY_FIELDS}
        changed.update(response_options=unit['answer_options'] != current['answer_options'],
                       reason_codes=unit['reason_codes'] != current['reason_codes'],
                       subtype_required=unit['subtype_required'] != current['subtype_required'])
        for field, differs in changed.items():
            counts[field] += int(differs)
        # Both sides use the runner's same canonical JSON encoding. Do not compare
        # a PostgreSQL jsonb-text hash with a Python serialization hash.
        same_packet = R.sha(R.encode(unit['packet'])) == R.sha(R.encode(current['packet']))
        rows.append({'unit_id': uid, 'displayed_text_identical': not any(changed.values()),
                     'packet_identical': same_packet, 'changed_fields': [k for k, v in changed.items() if v]})
    summary = {
        'unit_list_sha256_equal': live['freeze']['unit_list_sha256'] == ai['source']['sample_sha256'] ==
            R.sha('\n'.join(sorted(ai_units)).encode()),
        'import_sha256_equal': live['freeze']['import_sha256'] == ai['source']['prepared_import_sha256'],
        'displayed_text_differences': counts,
        'packet_differences': sum(not r['packet_identical'] for r in rows),
        'guide_live_sha256': live['guide']['sha256'], 'guide_ai_sha256': ai['guide']['sha256'],
    }
    return summary, rows


def main() -> int:
    p = R.QuietParser(description=__doc__)
    for name in ('ai-input', 'ai-sha256', 'live-snapshot', 'live-sha256'):
        p.add_argument('--' + name, required=True)
    a = p.parse_args()
    ai = R.validate_bundle(read_private(a.ai_input, a.ai_sha256), a.ai_sha256)
    live = validate_live(read_private(a.live_snapshot, a.live_sha256), a.live_sha256)
    result, _ = compare(ai, live)
    print(json.dumps(result, sort_keys=True))
    # A changed freeze is reported as unequal and stops chained analysis commands.
    return 0 if result['unit_list_sha256_equal'] and result['import_sha256_equal'] else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except R.Refused as error:
        print(json.dumps({'status': 'refused', 'category': str(error)}))
        raise SystemExit(2) from None
    except Exception:
        print(json.dumps({'status': 'refused', 'category': 'unexpected_failure'}))
        raise SystemExit(2) from None
