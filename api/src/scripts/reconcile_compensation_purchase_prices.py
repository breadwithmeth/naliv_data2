#!/usr/bin/env python3
"""Build a local compensation price-evidence snapshot (read-only PostgreSQL + 1C GET).

Example from naliv_data2 (collector requirements.txt supplies Python dependencies):
  python api/src/scripts/reconcile_compensation_purchase_prices.py --activity <GUID> \
    --from 2026-11-01 --to 2026-11-20 --coverage-floor 2026-06-01 \
    --coverage-to 2026-11-20 --out verify-out-compensation-price-audit/evidence.json

All date bounds labelled `to` are exclusive. Use the manifest's verified coverage;
API independently checks its own coverage. Pass --out to the app's evidence path
only for intentional installation: each successful run replaces the chosen file.
An adjacent .audit.json contains source coverage and reasons a proof was refused.
Evidence is a snapshot; rerun after backdated changes, not only after new movements.
The sibling naliv_data1 checkout supplies the shared OData source guard.
On a source pause the command exits 75 without replacing either output.
"""
from argparse import ArgumentParser
from collections import Counter, defaultdict
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from importlib import import_module
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit, unquote
from urllib.request import Request
from uuid import UUID
import base64

ZERO = '00000000-0000-0000-0000-000000000000'
REGISTER = 'InformationRegister_ЦеныНоменклатуры_RecordType'
REGISTRAR = 'StandardODATA.Document_УстановкаЦенНоменклатуры'
REGISTER_FIELDS = ('Period', 'Recorder', 'Recorder_Type', 'LineNumber', 'Active',
                   'ВидЦены_Key', 'Номенклатура_Key', 'Характеристика_Key', 'Упаковка_Key', 'Цена', 'Валюта')
PAGE = 200
MAX_PAGES = 25
MAX_BODY = 4 * 1024 * 1024
BATCH_ITEMS = 4
QUERY_ORDER = 'Period,Recorder,LineNumber'


class AuditError(ValueError):
    pass


def guid(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise AuditError('Invalid GUID in audit inputs/source') from None


def ref(value):
    return None if value in (None, '', ZERO) else guid(value)


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?', value):
        raise AuditError('Require an exact register business timestamp with no offset')
    return datetime.fromisoformat(value)


def as_decimal(value):
    try:
        amount = Decimal(str(value))
        return amount if amount.is_finite() and amount > 0 else None
    except (InvalidOperation, ValueError):
        return None


def prove_scope(local, rows, until):
    """Certify a positive local price only across a fully fetched exact source scope."""
    at = local['effective_at']
    latest = []
    boundary = min(until, local['next_at'] or until)
    for row in rows:
        if (row['Active'] is not True or ref(row['Упаковка_Key']) is not None
                or ref(row['Характеристика_Key']) != local['characteristic_key']
                or row['ВидЦены_Key'] != local['price_type_key'] or row['Номенклатура_Key'] != local['item_key']):
            continue
        moment = timestamp(row['Period'])
        if moment == at:
            latest.append(row)
        elif at < moment < boundary:
            boundary = moment
    if not latest:
        return None, 'register_missing_at_installation'
    if local['movement_at'] >= boundary:
        return None, 'register_changed_before_movement'
    values = {(as_decimal(r['Цена']), r['Валюта']) for r in latest}
    if len(values) != 1:
        return None, 'register_conflict'
    amount, currency = values.pop()
    if amount is None or amount != local['price']:
        return None, 'register_amount_mismatch'
    documents = {guid(r['Recorder']) for r in latest if r['Recorder_Type'] == REGISTRAR}
    if any(r['Recorder_Type'] != REGISTRAR for r in latest) or documents != set(local['document_keys']):
        return None, 'registrar_mismatch'
    # No authoritative blank-currency policy was available from the source. Never infer it.
    if currency != 'KZT':
        return None, 'currency_unconfirmed'
    return {'priceTypeKey': local['price_type_key'], 'itemKey': local['item_key'],
            'characteristicKey': local['characteristic_key'], 'packagingKey': None,
            'documentKeys': sorted(documents), 'effectiveAt': at.isoformat(),
            'price': format(amount, 'f'), 'currency': 'KZT',
            'verifiedThroughExclusive': boundary.isoformat()}, None


def _collector_checkout():
    return Path(__file__).resolve().parents[4] / 'naliv_data1'


def _load_source_transport():
    checkout = _collector_checkout()
    source = checkout / 'odata_client.py'
    error = 'A sibling naliv_data1 checkout with the shared OData source guard is required'
    if not source.is_file():
        raise AuditError(error)
    sys.path.insert(0, str(checkout))
    try:
        transport = import_module('odata_client')
    except ImportError:
        raise AuditError(error) from None
    finally:
        sys.path.pop(0)
    if (Path(getattr(transport, '__file__', None) or '').resolve() != source
            or not hasattr(transport, 'SourcePaused')):
        raise AuditError(error)
    return transport


class RegisterReader:
    def __init__(self, env):
        self.transport = _load_source_transport()
        base = env.get('ODATA_URL', '').rstrip('/') + '/'
        url = urlsplit(base)
        if url.scheme not in ('http', 'https') or not url.netloc or url.username or url.query or url.fragment:
            raise AuditError('Collector OData base address is invalid')
        try:
            credential = f"{env['ODATA_USER']}:{env['ODATA_PASSWORD']}".encode('utf-8')
        except KeyError:
            raise AuditError('Collector OData credentials are not configured') from None
        self.auth = 'Basic ' + base64.b64encode(credential).decode('ascii')
        self.url = urljoin(base, quote(REGISTER))
        self.requests = 0

    def get(self, url):
        self.requests += 1
        req = Request(url, headers={'Accept': 'application/json', 'Authorization': self.auth}, method='GET')
        try:
            response = self.transport.request_with_retry(req, timeout=25, max_response_bytes=MAX_BODY)
        except self.transport.ODataTransportError as error:
            if error.status_code is not None:
                raise AuditError(f'Register GET refused with status {error.status_code}') from None
            raise AuditError('Register GET transport failed') from None
        try:
            result = json.loads(response.body, parse_float=Decimal)
        except (ValueError, UnicodeError):
            raise AuditError('Register returned invalid JSON') from None
        if not isinstance(result, dict) or not isinstance(result.get('value'), list):
            raise AuditError('Register response has no complete result page')
        self.transport.record_source_rows(len(result['value']))
        return result

    def rows(self, price_type, items, start, end):
        if not items or len(items) > BATCH_ITEMS or start >= end:
            raise AuditError('Register GET scope is not bounded')
        item_filter = ' or '.join(f"Номенклатура_Key eq guid'{guid(item)}'" for item in items)
        where = (f"ВидЦены_Key eq guid'{guid(price_type)}' and ({item_filter}) and "
                 f"Period ge datetime'{start.isoformat()}' and Period lt datetime'{end.isoformat()}'")
        # 1C requires literal %20 (quote), not form-style '+' for OData expressions.
        query = {'$format': 'json', '$filter': where, '$orderby': QUERY_ORDER, '$top': PAGE}
        rows, ids, seen_urls = [], set(), set()
        next_url = None
        # A logical $top window can itself span multiple physical pages.
        for _ in range(MAX_PAGES):
            if next_url is None:
                window_start = len(rows)
            params = query | ({'$skip': len(rows)} if rows else {})
            url = next_url or self.url + '?' + urlencode(params, quote_via=quote, safe="()',:$")
            if url in seen_urls:
                raise AuditError('Register repeated a paging URL')
            seen_urls.add(url)
            result = self.get(url)
            page = result['value']
            if len(page) > PAGE - (len(rows) - window_start):
                raise AuditError('Register exceeded requested window size')
            for row in page:
                if not isinstance(row, dict) or any(k not in row for k in REGISTER_FIELDS):
                    raise AuditError('Register page lacks required dimensions or resources')
                moment = timestamp(row['Period'])
                if (not start <= moment < end or row['ВидЦены_Key'] != price_type or row['Номенклатура_Key'] not in items
                        or not isinstance(row['Active'], bool) or (rows and row['Period'] < rows[-1]['Period'])):
                    raise AuditError('Register row is outside its requested and ordered scope')
                identity = (row['Period'], row['Recorder_Type'], row['Recorder'], row['LineNumber'])
                if identity in ids:
                    raise AuditError('Register repeated a record across pages')
                ids.add(identity)
                rows.append({k: row[k] for k in REGISTER_FIELDS})
            link = result.get('@odata.nextLink') or result.get('odata.nextLink')
            if link:
                if not isinstance(link, str) or not page or len(rows) - window_start >= PAGE:
                    raise AuditError('Register next link does not continue an incomplete window')
                next_url = urljoin(self.url, link)
                orig, nex = urlsplit(self.url), urlsplit(next_url)
                pairs = parse_qsl(nex.query, keep_blank_values=True)
                nq = dict(pairs)
                if (nex.fragment or len(pairs) != len(nq)
                        or (nex.scheme, nex.netloc, unquote(nex.path)) != (orig.scheme, orig.netloc, unquote(orig.path))
                        or nq.get('$filter') != where or nq.get('$orderby') != QUERY_ORDER
                        or (not nq.get('$skiptoken') and nq.get('$skip') != str(len(rows)))):
                    raise AuditError('Register next link escaped requested filter/order or paging cursor')
            elif len(rows) - window_start < PAGE:
                return rows
            else:
                next_url = None
        raise AuditError('Register pagination exceeded its per-batch cap')


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
            temp = Path(f.name)
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)
            f.write('\n')
        temp.replace(path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def count_statuses(rows):
    final, register = defaultdict(Counter), defaultdict(Counter)
    for row in rows:
        counts = dict(keys=1, sale_lines=row['sale_lines'], return_lines=row['return_lines'])
        final[row['final_status']].update(counts)
        if row.get('register_status'):
            register[row['register_status']].update(counts)
    return final, register


def main(argv=None):
    from dotenv import dotenv_values
    import psycopg
    from psycopg.rows import dict_row

    parser = ArgumentParser(description=__doc__)
    collector_env = _collector_checkout() / '.env'
    parser.add_argument('--dotenv', type=Path, default=collector_env)
    parser.add_argument('--activity', required=True, type=guid)
    parser.add_argument('--from', dest='start', required=True, type=date.fromisoformat)
    parser.add_argument('--to', dest='end', required=True, type=date.fromisoformat)
    parser.add_argument('--coverage-floor', required=True, type=date.fromisoformat)
    parser.add_argument('--coverage-to', required=True, type=date.fromisoformat)
    parser.add_argument('--max-scope-pairs', type=int, default=100)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(argv)
    if not 1 <= (args.end - args.start).days <= 366 or not args.coverage_floor < args.coverage_to:
        parser.error('Specify a report of at most 366 days and an ordered coverage interval')
    if not 1 <= args.max_scope_pairs <= 1000:
        parser.error('--max-scope-pairs must be between 1 and 1000')
    env = {**dotenv_values(args.dotenv), **os.environ}
    schema = env.get('PGSCHEMA', '')
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', schema) or not env.get('DATABASE_URL'):
        parser.error('Collector DB URL or raw schema is not configured')
    reader = RegisterReader(env)
    uri = urlsplit(env['DATABASE_URL'])
    dsn = urlunsplit(uri._replace(query=urlencode([(k, v) for k, v in parse_qsl(uri.query) if k != 'schema'])))
    query = {'from': args.start, 'to': args.end, 'activity': args.activity,
             'floor': args.coverage_floor, 'verified_to': args.coverage_to}
    local_sql = Path(__file__).with_name('compensation-purchase-price-candidates.sql')
    try:
        with psycopg.connect(dsn, connect_timeout=8, row_factory=dict_row,
                            options=f'-c default_transaction_read_only=on -c statement_timeout=45000 -c search_path={schema},pg_catalog') as conn:
            candidates = conn.execute(local_sql.read_text(encoding='utf-8'), query).fetchall()
    except psycopg.Error as error:
        raise AuditError(f'Replica SELECT failed: {type(error).__name__} {error.sqlstate or ""}') from None

    pair_rows = defaultdict(lambda: defaultdict(list))
    for row in candidates:
        if row['local_status'] == 'local_candidate':
            pair_rows[row['price_type_key']][row['item_key']].append(row)
    if sum(map(len, pair_rows.values())) > args.max_scope_pairs:
        raise AuditError('Activity exceeds source item/purchase-type scope limit; narrow the report or choose a reviewed limit')

    end = datetime.combine(min(args.end, args.coverage_to), time.min)
    register_pages, proofs = [], {}
    for price_type, items in pair_rows.items():
        sorted_items = sorted(items)
        for offset in range(0, len(sorted_items), BATCH_ITEMS):
            batch = sorted_items[offset:offset + BATCH_ITEMS]
            local = [row for item in batch for row in items[item]]
            start = min(row['effective_at'] for row in local).replace(microsecond=0)
            try:
                source = reader.rows(price_type, batch, start, end)
            except reader.transport.SourcePaused as error:
                print(f'source_paused: {error.reason}', file=sys.stderr)
                return 75
            register_pages.append({'priceTypeKey': price_type, 'itemKeys': batch, 'from': start.isoformat(),
                                   'toExclusive': end.isoformat(), 'rows': source})
            by_item = defaultdict(list)
            for row in source:
                by_item[row['Номенклатура_Key']].append(row)
            for row in local:
                proof, issue = prove_scope(row, by_item[row['item_key']], end)
                row['register_status'] = issue or 'verified'
                row['final_status'] = 'verified' if proof else 'purchase_price_unverified'
                if proof:
                    proof_key = (proof['priceTypeKey'], proof['itemKey'], proof['characteristicKey'], proof['effectiveAt'])
                    proofs[proof_key] = proof
    output = {'version': 2, 'scopes': list(proofs.values())}
    for row in candidates:
        row.setdefault('final_status', row['local_status'])
    counts, register_counts = count_statuses(candidates)
    audit = {'readAtUtc': datetime.now(timezone.utc).isoformat(), 'query': query, 'requests': reader.requests,
             'counts': counts, 'registerCounts': register_counts, 'scopesEmitted': len(proofs),
             'sourceBatches': register_pages, 'candidateRows': candidates,
             'candidateSqlSha256': sha256(local_sql.read_bytes()).hexdigest()}
    write_json(args.out.with_suffix('.audit.json'), audit)
    write_json(args.out, output)
    print(json.dumps({'scopes': len(proofs), 'registerGets': reader.requests, 'counts': counts,
                      'registerCounts': register_counts}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, OSError) as exc:
        message = str(exc) if isinstance(exc, AuditError) else 'Invalid source/configuration or evidence output could not be written'
        raise SystemExit(message) from None
