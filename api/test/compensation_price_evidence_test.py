"""python -m unittest discover -s api/test -p compensation_price_evidence_test.py"""
from contextlib import contextmanager, redirect_stderr
from datetime import datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest import mock
from urllib.parse import parse_qsl, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import reconcile_compensation_purchase_prices as evidence
from reconcile_compensation_purchase_prices import AuditError, RegisterReader, count_statuses, prove_scope

AT = datetime(2026, 11, 3, 15, 4, 5)
MOVE = datetime(2026, 11, 15, 18, 0)
THROUGH = datetime(2026, 11, 20)
KEY = '11111111-1111-1111-1111-111111111111'
TYPE = '22222222-2222-2222-2222-222222222222'
ITEM = '33333333-3333-3333-3333-333333333333'
ZERO = '00000000-0000-0000-0000-000000000000'


def local(**fields):
    return dict(price_type_key=TYPE, item_key=ITEM, characteristic_key=None,
                effective_at=AT, price=Decimal('600.25'), document_keys=[KEY],
                movement_at=MOVE, next_at=None) | fields


def register(**fields):
    return dict(Period=AT.isoformat(), Recorder=KEY,
                Recorder_Type='StandardODATA.Document_УстановкаЦенНоменклатуры',
                LineNumber='100', Active=True, ВидЦены_Key=TYPE, Номенклатура_Key=ITEM,
                Характеристика_Key=ZERO, Упаковка_Key=ZERO, Цена=Decimal('600.25'), Валюта='KZT') | fields


@contextmanager
def register_server(status, *, headers=None, body=b''):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(status if self.path != '/other' else 200)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = Thread(target=server.serve_forever, kwargs={'poll_interval': .02})
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}/odata/', requests
        finally:
            server.shutdown()
            thread.join()


class EvidenceSourcePolicy(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name)
        environment = mock.patch.dict(os.environ, {
            'NALIV_TEST_ODATA_GATE_DIR': str(self.directory / 'gate'),
            'NO_PROXY': '127.0.0.1',
        })
        environment.start()
        self.addCleanup(environment.stop)

    def reader_env(self, base):
        return {'ODATA_URL': base, 'ODATA_USER': 'fixture', 'ODATA_PASSWORD': 'fixture-secret'}

    def test_register_preserves_non_ieee_wire_amount(self):
        body = b'{"value":[{"amount":9007199254740993.125}]}'
        with register_server(200, body=body) as (base, requests):
            reader = RegisterReader(self.reader_env(base))
            result = reader.get(reader.url)

        self.assertEqual(Decimal('9007199254740993.125'), result['value'][0]['amount'])
        self.assertEqual(1, len(requests))

    def test_register_never_follows_redirect(self):
        with register_server(302, headers={'Location': '/other'}) as (base, requests):
            reader = RegisterReader(self.reader_env(base))
            with self.assertRaises(AuditError):
                reader.get(reader.url)

        self.assertEqual(1, len(requests))
        self.assertNotIn('/other', requests)

    def test_register_pauses_when_response_exceeds_its_byte_cap(self):
        with register_server(200, headers={'Content-Length': '4194305'}) as (base, requests):
            reader = RegisterReader(self.reader_env(base))
            for _ in range(2):
                with self.assertRaises(reader.transport.SourcePaused):
                    reader.get(reader.url)

        self.assertEqual(1, len(requests))

    def test_missing_sibling_transport_fails_before_any_http(self):
        isolated = self.directory / 'isolated/naliv_data2/api/src/scripts/reconcile.py'
        with (
            register_server(200, body=b'{"value":[]}') as (base, requests),
            mock.patch.object(evidence, '__file__', str(isolated)),
        ):
            with self.assertRaisesRegex(AuditError, 'sibling naliv_data1'):
                reader = RegisterReader(self.reader_env(base))
                reader.get(reader.url)

        self.assertEqual([], requests)

    def test_paused_evidence_run_preserves_previous_evidence_and_audit(self):
        import psycopg

        out = self.directory / 'evidence.json'
        audit = out.with_suffix('.audit.json')
        out.write_bytes(b'previous evidence')
        audit.write_bytes(b'previous audit')
        argv = [
            '--dotenv', str(self.directory / 'unused.env'), '--activity', KEY,
            '--from', '2026-11-01', '--to', '2026-11-20',
            '--coverage-floor', '2026-11-01', '--coverage-to', '2026-11-20',
            '--out', str(out),
        ]
        diagnostics = io.StringIO()
        with (
            register_server(429, headers={'Retry-After': '120'}, body=b'fixture-secret') as (base, requests),
            mock.patch.dict(os.environ, self.reader_env(base) | {
                'PGSCHEMA': 'fixture', 'DATABASE_URL': 'postgresql://127.0.0.1/fixture',
            }),
            mock.patch.object(psycopg, 'connect') as connect,
            redirect_stderr(diagnostics),
        ):
            connect.return_value.__enter__.return_value.execute.return_value.fetchall.return_value = [
                local(local_status='local_candidate', sale_lines=1, return_lines=0),
            ]
            self.assertEqual(75, evidence.main(argv))

        self.assertEqual(b'previous evidence', out.read_bytes())
        self.assertEqual(b'previous audit', audit.read_bytes())
        self.assertEqual(1, len(requests))
        self.assertIn('source_paused', diagnostics.getvalue())
        self.assertNotIn('fixture-secret', diagnostics.getvalue())


class EvidenceScope(unittest.TestCase):
    def test_exact_active_base_scope_emits_canonical_contract(self):
        proof, issue = prove_scope(local(), [register()], THROUGH)
        self.assertIsNone(issue)
        self.assertEqual(proof, dict(priceTypeKey=TYPE, itemKey=ITEM, characteristicKey=None,
                                     packagingKey=None, documentKeys=[KEY], currency='KZT',
                                     effectiveAt='2026-11-03T15:04:05', price='600.25',
                                     verifiedThroughExclusive='2026-11-20T00:00:00'))

    def test_currency_never_inferred_and_same_moment_conflicts_never_certified(self):
        for rows, issue in [([register(Валюта='')], 'currency_unconfirmed'),
                            ([register(Валюта='USD')], 'currency_unconfirmed'),
                            ([register(), register(Цена=Decimal('601'))], 'register_conflict'),
                            ([register(), register(Валюта='')], 'register_conflict')]:
            with self.subTest(issue=issue, rows=rows):
                self.assertEqual(prove_scope(local(), rows, THROUGH), (None, issue))

    def test_exact_registrar_and_moment_required(self):
        self.assertEqual(prove_scope(local(), [register(Recorder=ITEM)], THROUGH), (None, 'registrar_mismatch'))
        self.assertEqual(prove_scope(local(), [register(Period='2026-11-03T15:04:06')], THROUGH), (None, 'register_missing_at_installation'))

    def test_complete_same_moment_registrar_set_is_sorted_and_required(self):
        rows = [register(), register(Recorder=ITEM)]
        proof, issue = prove_scope(local(document_keys=[ITEM, KEY]), rows, THROUGH)
        self.assertIsNone(issue)
        self.assertEqual(proof['documentKeys'], [KEY, ITEM])
        self.assertEqual(prove_scope(local(document_keys=[ITEM, KEY]), rows[:1], THROUGH),
                         (None, 'registrar_mismatch'))

    def test_next_active_change_caps_proof_even_when_amount_matches(self):
        change = register(Period='2026-11-17T18:00:00', Recorder=ITEM)
        proof, issue = prove_scope(local(), [register(), change], THROUGH)
        self.assertIsNone(issue)
        self.assertEqual(proof['verifiedThroughExclusive'], '2026-11-17T18:00:00')
        self.assertEqual(prove_scope(local(movement_at=datetime(2026, 11, 17, 18)), [register(), change], THROUGH),
                         (None, 'register_changed_before_movement'))
        self.assertEqual(prove_scope(local(), [register(), dict(change, Active=False)], THROUGH)[0]['verifiedThroughExclusive'],
                         '2026-11-20T00:00:00')

    def test_verified_movement_occurs_once_in_each_diagnostic_denominator(self):
        rows = [dict(final_status='verified', register_status='verified', sale_lines=2, return_lines=1),
                dict(final_status='purchase_price_unverified', sale_lines=1, return_lines=0)]
        final, register = count_statuses(rows)
        self.assertEqual(final['verified'], {'keys': 1, 'sale_lines': 2, 'return_lines': 1})
        self.assertEqual(final['purchase_price_unverified'], {'keys': 1, 'sale_lines': 1, 'return_lines': 0})
        self.assertEqual(register, {'verified': {'keys': 1, 'sale_lines': 2, 'return_lines': 1}})

    def test_wrong_packaging_or_characteristic_does_not_supply_or_block_base_price(self):
        others = [register(Упаковка_Key=TYPE), register(Характеристика_Key=ITEM)]
        self.assertEqual(prove_scope(local(), others, THROUGH), (None, 'register_missing_at_installation'))
        self.assertIsNone(prove_scope(local(), [register(), *others], THROUGH)[1])

    def test_full_split_server_window_fetches_newer_change_at_record_201(self):
        earlier = [register(LineNumber=str(i)) for i in range(200)]
        later = register(Period='2026-11-13T18:00:00', Recorder=ITEM)

        class PagedResponse(RegisterReader):
            def __init__(self):
                super().__init__(dict(ODATA_URL='http://example.test/odata/', ODATA_USER='', ODATA_PASSWORD=''))

            def get(self, url):
                params = dict(parse_qsl(urlsplit(url).query))
                if params.get('$skip') == '200':
                    return {'value': [later]}
                if params.get('$skiptoken') == 'continuation':
                    return {'value': earlier[100:]}
                link = self.url + '?' + urlencode(params | {'$skiptoken': 'continuation'})
                return {'value': earlier[:100], 'odata.nextLink': link}

        complete = PagedResponse().rows(TYPE, [ITEM], AT, THROUGH)
        self.assertEqual(len(complete), 201)
        self.assertEqual(prove_scope(local(), complete, THROUGH), (None, 'register_changed_before_movement'))
