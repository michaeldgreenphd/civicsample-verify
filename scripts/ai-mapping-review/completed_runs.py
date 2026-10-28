"""Read-only validation and cumulative accounting of completed private experiments."""
from __future__ import annotations

import json

import runner as R
import label_pilot as P
from check_live_comparability import read_private


def mapping_records(bundle: dict, raw: bytes, digest: str, input_digest: str, *, require_complete: bool = True) -> dict:
    R.require(R.sha(raw) == digest, 'baseline_digest_mismatch')
    state = R.decode(raw)
    # Bundle validation must use its original pinned bytes upstream; re-encoding
    # here is only for response/request reconstruction, never for changing a pin.
    R.validate_state(state, input_digest, state.get('cap_micro_usd'), state.get('approval_ref'))
    R.validate_recovery_requests(bundle, state)
    units = {u['unit_id']: u for u in bundle['units']}
    seen = set()
    for record in state['records']:
        key = (record['model'], record['unit_id'])
        R.require(key not in seen and key[0] in R.MODELS and key[1] in units, 'invalid_ledger')
        seen.add(key)
        unit = units[key[1]]
        request = R.request_for(bundle, unit, key[0])
        R.require(record.get('request_sha256') == R.sha(R.encode(request)) and
                  record.get('reserved_micro_usd') == R.reserve_cost(request), 'ledger_binding_mismatch')
        R.require(record['status'] == 'complete', 'baseline_incomplete')
        cost, usage = R.usage_cost(record['response'], key[0])
        R.require(cost == record.get('charged_micro_usd') and usage == record.get('usage') and
                  cost <= record['reserved_micro_usd'] and usage['output_tokens'] <= R.MAX_OUTPUT_TOKENS,
                  'invalid_ledger')
        R.require(R.validate_response(record['response'], key[0], unit) == record.get('answer'), 'invalid_ledger')
    if require_complete:
        R.require(seen == {(m, u) for m in R.MODELS for u in units}, 'baseline_incomplete')
    return state


def verify_prior(mapping_raw: bytes, mapping_digest: str, pilot_input_raw: bytes,
                 pilot_input_digest: str, pilot_raw: bytes, pilot_digest: str) -> tuple[dict, dict, dict]:
    b = P.validate_bundle(pilot_input_raw, pilot_input_digest)
    R.require(b['baseline']['ledger_sha256'] == mapping_digest, 'baseline_digest_mismatch')
    mapping = mapping_records(P.original(b), mapping_raw, mapping_digest, b['baseline']['input_sha256'])
    base_cost = P.verify_baseline(b, mapping_raw)
    R.require(R.sha(pilot_raw) == pilot_digest, 'pilot_digest_mismatch')
    pilot = R.decode(pilot_raw)
    P.validate_state(b, pilot_input_digest, pilot, base_cost,
                     pilot.get('pilot_cap_micro_usd'), pilot.get('approval_ref'))
    summary = P.summary(b, pilot_input_digest, pilot)
    R.require(summary['status'] in ('complete', 'complete_with_missing_outputs'), 'pilot_incomplete')
    combined = base_cost + P.pilot_cost(pilot)
    # P's baseline already includes R's held schema-recovery reservation. Count
    # each ledger once; adding P's combined summary to R would double count B.
    result = {'mapping': R.summary(mapping), 'label_pilot': summary,
              'combined_accounted_micro_usd': combined,
              'remaining_micro_usd': R.MAX_CAP_MICRO_USD - combined}
    return mapping, pilot, result


def main() -> None:
    p = R.QuietParser(description=__doc__)
    for name in ('mapping-ledger', 'mapping-sha256', 'pilot-input', 'pilot-input-sha256',
                 'pilot-ledger', 'pilot-sha256'):
        p.add_argument('--' + name, required=True)
    a = p.parse_args()
    _, _, summary = verify_prior(read_private(a.mapping_ledger, a.mapping_sha256), a.mapping_sha256,
        read_private(a.pilot_input, a.pilot_input_sha256), a.pilot_input_sha256,
        read_private(a.pilot_ledger, a.pilot_sha256), a.pilot_sha256)
    print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except R.Refused as error:
        print(json.dumps({'status': 'refused', 'category': str(error)}))
        raise SystemExit(2) from None
    except Exception:
        print(json.dumps({'status': 'refused', 'category': 'unexpected_failure'}))
        raise SystemExit(2) from None
