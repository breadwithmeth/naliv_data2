import type { Prisma as PrismaClientTypes } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import type {
  PresentationReportBlock, PresentationSupplier, PurchasingQuality, SupplierAttributionAudit,
  SupplierIncomeMetrics, SupplierIncomeReason, SupplierIncomeResidual
} from "./presentation-report-types.js";
import type { ComparisonPeriod, YearComparisonReport } from "./year-comparison.js";

const emptyReference = "00000000-0000-0000-0000-000000000000";
const periodOrder: Record<ComparisonPeriod, number> = { current: 0, previous: 1 };
const materialQuantity = 1e-9;

type PurchaseRow = {
  period: ComparisonPeriod;
  sourceStoreKey: string | null;
  physicalStoreKey: string | null;
  city: string;
  supplierKey: string;
  supplierName: string;
  internalByTaxId: boolean;
  receiptDocuments: number;
  returnDocuments: number;
  receiptAmount: number | null;
  returnAmount: number | null;
};
type PurchaseCandidates = {
  period: ComparisonPeriod;
  sourceStoreKey: string;
  itemKey: string;
  supplierCandidates: string[];
  unknownSupplierLines: number;
};
type PurchasingPayload = {
  suppliers: PurchaseRow[];
  candidates: PurchaseCandidates[];
  quality: PurchasingQuality[];
};
type IncomeAccumulator = Omit<SupplierIncomeMetrics, "estimatedGrossIncome"> & { knownCost: number };
type SupplierAccumulator = {
  row: Omit<PresentationSupplier, keyof SupplierIncomeMetrics>;
  income: IncomeAccumulator;
  cohortIncome: IncomeAccumulator;
};
type ResidualAccumulator = {
  period: ComparisonPeriod;
  city: string;
  reason: Exclude<SupplierIncomeReason, "unique">;
  pairCount: number;
  income: IncomeAccumulator;
};

function table(name: string) {
  return Prisma.raw(`"${config.PGSCHEMA.replaceAll('"', '""')}"."${name}"`);
}

function validReference(expression: Prisma.Sql) {
  return Prisma.sql`nullif(nullif(trim(${expression}), ''), ${emptyReference})`;
}

function russianLower(expression: Prisma.Sql) {
  return Prisma.sql`translate(lower(${expression}),
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')`;
}

async function readPurchasing(sales: YearComparisonReport, client: PrismaClientTypes.TransactionClient) {
  const query = Prisma.sql`
    with windows(period, date_from, date_to) as (
      values ('current'::text, ${sales.periods.current.from}::timestamp, ${sales.periods.current.to}::timestamp),
        ('previous'::text, ${sales.periods.previous.from}::timestamp, ${sales.periods.previous.to}::timestamp)
    ), warehouse_stores as (
      select ref_key, max(${validReference(Prisma.sql`magazin_key`)}) as store_key
      from ${table("catalog_sklady")} group by ref_key
    ), store_names as (
      select ref_key, max(nullif(description, '')) as name
      from ${table("catalog_magaziny")} group by ref_key
    ), organization_tax_ids as (
      select distinct regexp_replace(trim(inn), '[^0-9]', '', 'g') as tax_id
      from ${table("catalog_organizatsii")}
      where regexp_replace(trim(inn), '[^0-9]', '', 'g') ~ '[1-9]'
    ), supplier_catalog as (
      select ${validReference(Prisma.sql`c.ref_key`)} as supplier_key,
        max(nullif(trim(c.description), '')) as name,
        bool_or(exists(select 1 from organization_tax_ids o
          where o.tax_id = regexp_replace(trim(c.inn), '[^0-9]', '', 'g'))) as internal_by_tax_id
      from ${table("catalog_kontragenty")} c
      where ${validReference(Prisma.sql`c.ref_key`)} is not null
      group by 1
    ), receipt_documents as materialized (
      select w.period, 'receipt'::text as kind, d.ref_key, d.date,
        coalesce(${validReference(Prisma.sql`d.magazin_key`)}, s.store_key) as source_store_key,
        ${validReference(Prisma.sql`d.kontragent_key`)} as supplier_key,
        d.summa_dokumenta::numeric as amount
      from windows w join ${table("document_postuplenie_tovarov")} d
        on d.date >= w.date_from and d.date < w.date_to
      left join warehouse_stores s on s.ref_key = d.sklad_key
      where d.posted = true and d.deletion_mark is not true
    ), return_documents as materialized (
      select w.period, 'return'::text as kind, d.ref_key, d.date,
        coalesce(${validReference(Prisma.sql`d.magazin_key`)}, s.store_key) as source_store_key,
        ${validReference(Prisma.sql`d.kontragent_key`)} as supplier_key,
        abs(d.summa_dokumenta)::numeric as amount
      from windows w join ${table("document_vozvrat_tovarov_postavschiku")} d
        on d.date >= w.date_from and d.date < w.date_to
      left join warehouse_stores s on s.ref_key = d.sklad_key
      where d.posted = true and d.deletion_mark is not true
    ), raw_documents as (
      select * from receipt_documents union all select * from return_documents
    ), source_names as (
      select s.source_store_key, coalesce(n.name, s.source_store_key) as name
      from (select distinct source_store_key from raw_documents where source_store_key is not null) s
      left join store_names n on n.ref_key = s.source_store_key
    ), addresses as (
      select *, substring(${russianLower(Prisma.sql`name`)} from 'г[.].*$') as canonical_address
      from source_names
    ), locations as (
      select *, substring(canonical_address from '^г[.]\\s*([^[:space:],;]+)') as canonical_city
      from addresses
    ), source_stores as (
      select source_store_key,
        case when canonical_address ~ '^г[.]\\s*[^[:space:]]+\\s+.+$'
          then 'address:' || regexp_replace(trim(canonical_address), '\\s+', ' ', 'g')
          else 'key:' || source_store_key end as physical_store_key,
        coalesce(translate(left(canonical_city, 1),
          'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')
          || substring(canonical_city from 2), 'Без города') as city
      from locations
    ), documents as materialized (
      select d.*, s.physical_store_key, coalesce(s.city, 'Без города') as city
      from raw_documents d left join source_stores s on s.source_store_key = d.source_store_key
    ), receipt_lines as materialized (
      select d.period, d.ref_key, d.source_store_key, d.supplier_key,
        coalesce(l.nomenklatura_key, '') as item_key, l.kolichestvo as quantity, l.summa::numeric as amount
      from receipt_documents d join ${table("document_postuplenie_tovarov_tovary")} l
        on l."_parent_ref_key" = d.ref_key
    ), line_presence as (
      select period, ref_key, count(*) as line_count,
        count(*) filter (where amount is null) as missing_amounts, sum(amount) as amount
      from receipt_lines group by period, ref_key
    ), candidates as (
      select period, source_store_key, item_key,
        coalesce(array_agg(distinct supplier_key order by supplier_key)
          filter (where supplier_key is not null), array[]::text[]) as supplier_candidates,
        count(*) filter (where supplier_key is null) as unknown_supplier_lines
      from receipt_lines where quantity > 0 and source_store_key is not null
        and item_key not in ('', ${emptyReference})
      group by period, source_store_key, item_key
    ), supplier_purchases as (
      select d.period, d.source_store_key, d.physical_store_key, d.city, d.supplier_key,
        coalesce(c.name, d.supplier_key) as supplier_name, coalesce(c.internal_by_tax_id, false) as internal_by_tax_id,
        count(*) filter (where d.kind = 'receipt') as receipt_documents,
        count(*) filter (where d.kind = 'return') as return_documents,
        case when count(*) filter (where d.kind = 'receipt' and d.amount is null) = 0
          then coalesce(sum(d.amount) filter (where d.kind = 'receipt'), 0) end as receipt_amount,
        case when count(*) filter (where d.kind = 'return' and d.amount is null) = 0
          then coalesce(sum(d.amount) filter (where d.kind = 'return'), 0) end as return_amount
      from documents d left join supplier_catalog c on c.supplier_key = d.supplier_key
      where d.supplier_key is not null
      group by d.period, d.source_store_key, d.physical_store_key, d.city, d.supplier_key, c.name, c.internal_by_tax_id
    ), source_history as (
      select min(date) as date_from, max(date) as date_to
      from ${table("document_postuplenie_tovarov")} where posted = true and deletion_mark is not true
    ), quality_facts as (
      select w.period, w.date_from as requested_from, w.date_to as requested_to,
        min(d.date) as date_from, max(d.date) as date_to,
        count(d.kind) as document_count,
        count(d.kind) filter (where d.kind = 'receipt') as receipt_documents,
        count(d.kind) filter (where d.kind = 'return') as return_documents,
        count(distinct d.supplier_key) as supplier_count,
        count(d.kind) filter (where d.kind = 'receipt' and d.amount is null) as missing_receipt_amounts,
        count(d.kind) filter (where d.kind = 'return' and d.amount is null) as missing_return_amounts,
        count(d.kind) filter (where d.kind = 'receipt' and l.line_count is null) as receipts_without_lines,
        sum(d.amount) filter (where d.kind = 'receipt') as receipt_amount,
        sum(d.amount) filter (where d.kind = 'return') as return_amount,
        sum(l.amount) filter (where d.kind = 'receipt') as line_amount,
        coalesce(sum(l.missing_amounts) filter (where d.kind = 'receipt'), 0) as missing_line_amounts
      from windows w left join documents d on d.period = w.period
      left join line_presence l on l.period = d.period and l.ref_key = d.ref_key and d.kind = 'receipt'
      group by w.period, w.date_from, w.date_to
    ), quality as (
      select q.*, h.date_from as source_date_from, h.date_to as source_date_to,
        case when q.document_count = 0 then 'empty'
          when h.date_from is null or h.date_from::date > q.requested_from::date
            or h.date_to::date < q.requested_to::date - 1 then 'partial' else 'observed' end as status,
        case when q.document_count > 0 and q.missing_receipt_amounts = 0
          then coalesce(q.receipt_amount, 0) end as known_receipt_amount,
        case when q.document_count > 0 and q.missing_return_amounts = 0
          then coalesce(q.return_amount, 0) end as known_return_amount,
        case when q.receipt_documents > 0 and q.receipts_without_lines = 0 and q.missing_line_amounts = 0
          then q.line_amount end as known_line_amount
      from quality_facts q cross join source_history h
    )
    select jsonb_build_object(
      'suppliers', coalesce((select jsonb_agg(jsonb_build_object(
        'period', period, 'sourceStoreKey', source_store_key, 'physicalStoreKey', physical_store_key,
        'city', city, 'supplierKey', supplier_key, 'supplierName', supplier_name, 'internalByTaxId', internal_by_tax_id,
        'receiptDocuments', receipt_documents, 'returnDocuments', return_documents,
        'receiptAmount', receipt_amount, 'returnAmount', return_amount)
        order by period, source_store_key, supplier_key) from supplier_purchases), '[]'::jsonb),
      'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'period', period, 'sourceStoreKey', source_store_key, 'itemKey', item_key,
        'supplierCandidates', supplier_candidates, 'unknownSupplierLines', unknown_supplier_lines)
        order by period, source_store_key, item_key) from candidates), '[]'::jsonb),
      'quality', (select jsonb_agg(jsonb_build_object(
        'period', period, 'status', status,
        'dateFrom', to_char(date_from, 'YYYY-MM-DD'), 'dateTo', to_char(date_to, 'YYYY-MM-DD'),
        'sourceDateFrom', to_char(source_date_from, 'YYYY-MM-DD'), 'sourceDateTo', to_char(source_date_to, 'YYYY-MM-DD'),
        'receiptDocuments', receipt_documents, 'returnDocuments', return_documents, 'supplierCount', supplier_count,
        'missingReceiptAmounts', missing_receipt_amounts, 'missingReturnAmounts', missing_return_amounts,
        'receiptsWithoutLines', receipts_without_lines, 'receiptAmount', known_receipt_amount,
        'returnAmount', known_return_amount, 'purchaseLineAmount', known_line_amount,
        'documentLineDifference', known_receipt_amount - known_line_amount)
        order by period) from quality)
    ) as payload
  `;
  const [result] = await client.$queryRaw<Array<{ payload: PurchasingPayload }>>(query);
  return result.payload;
}

function newIncome(): IncomeAccumulator {
  return { salesRevenue: 0, knownEstimatedGrossIncome: 0, absoluteQuantity: 0, unvaluedQuantity: 0, knownCost: 0 };
}

function addIncome(target: IncomeAccumulator, fact: YearComparisonReport["dataQuality"]["valuation"][number]) {
  const unvaluedQuantity = fact.unitCost === null ? fact.absoluteQuantity : 0;
  const unvaluedRevenue = fact.unvaluedRevenue ?? (unvaluedQuantity > materialQuantity ? fact.revenue : 0);
  target.salesRevenue += fact.revenue;
  // A zero here is a known-cost-subset sum, never a substitute for full unknown cost.
  target.knownCost += fact.valuedCost ?? 0;
  target.knownEstimatedGrossIncome += fact.revenue - unvaluedRevenue - (fact.valuedCost ?? 0);
  target.absoluteQuantity += fact.absoluteQuantity;
  target.unvaluedQuantity += unvaluedQuantity;
}

function incomeMetrics(income: IncomeAccumulator, available: boolean): SupplierIncomeMetrics {
  return {
    salesRevenue: income.salesRevenue,
    estimatedGrossIncome: available && income.unvaluedQuantity <= materialQuantity
      ? income.salesRevenue - income.knownCost : null,
    knownEstimatedGrossIncome: income.knownEstimatedGrossIncome,
    absoluteQuantity: income.absoluteQuantity,
    unvaluedQuantity: income.unvaluedQuantity
  };
}

function addAmount(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right;
}

export async function getPresentationSupplierData(
  sales: YearComparisonReport,
  client: PrismaClientTypes.TransactionClient
): Promise<Pick<PresentationReportBlock, "suppliers" | "residual" | "attribution" | "purchasingQuality">> {
  const purchasing = await readPurchasing(sales, client);
  const sourceStores = new Map(sales.dataQuality.sourceStores.map((store) => [store.key, store]));
  const selectedPhysicalStores = new Set(sales.cohort.selectedStoreKeys);
  const hasCohort = selectedPhysicalStores.size > 0;
  const salesAvailable: Record<ComparisonPeriod, boolean> = {
    current: sales.coverage.some((coverage) => coverage.period === "current" && coverage.status !== "empty"),
    previous: sales.coverage.some((coverage) => coverage.period === "previous" && coverage.status !== "empty")
  };
  const candidatesByPair = new Map(purchasing.candidates.map((candidate) =>
    [JSON.stringify([candidate.period, candidate.sourceStoreKey, candidate.itemKey]), candidate]));
  const supplierMetadata = new Map<string, { supplierName: string; internalByTaxId: boolean }>();
  const suppliers = new Map<string, SupplierAccumulator>();
  const residual = new Map<string, ResidualAccumulator>();
  const attribution: SupplierAttributionAudit[] = [];

  const ensureSupplier = (period: ComparisonPeriod, city: string, key: string) => {
    const aggregateKey = JSON.stringify([period, city, key]);
    let accumulator = suppliers.get(aggregateKey);
    if (!accumulator) {
      const metadata = supplierMetadata.get(key);
      accumulator = {
        row: { period, city, supplierKey: key, supplierName: metadata?.supplierName ?? key,
          internalByTaxId: metadata?.internalByTaxId ?? false, receiptDocuments: 0, returnDocuments: 0,
          receiptAmount: 0, returnAmount: 0, purchases: 0, cohortPurchases: hasCohort ? 0 : null,
          cohortEstimatedGrossIncome: null },
        income: newIncome(), cohortIncome: newIncome()
      };
      suppliers.set(aggregateKey, accumulator);
    }
    return accumulator;
  };

  for (const purchase of purchasing.suppliers) {
    supplierMetadata.set(purchase.supplierKey,
      { supplierName: purchase.supplierName, internalByTaxId: purchase.internalByTaxId });
  }
  for (const purchase of purchasing.suppliers) {
    const mappedStore = purchase.sourceStoreKey === null ? undefined : sourceStores.get(purchase.sourceStoreKey);
    const city = mappedStore?.city ?? purchase.city;
    const physicalStoreKey = mappedStore?.physicalKey ?? purchase.physicalStoreKey;
    const supplier = ensureSupplier(purchase.period, city, purchase.supplierKey);
    supplier.row.receiptDocuments += purchase.receiptDocuments;
    supplier.row.returnDocuments += purchase.returnDocuments;
    supplier.row.receiptAmount = addAmount(supplier.row.receiptAmount, purchase.receiptAmount);
    supplier.row.returnAmount = addAmount(supplier.row.returnAmount, purchase.returnAmount);
    supplier.row.purchases = supplier.row.receiptAmount === null || supplier.row.returnAmount === null
      ? null : supplier.row.receiptAmount - supplier.row.returnAmount;
    if (hasCohort && physicalStoreKey !== null && selectedPhysicalStores.has(physicalStoreKey)) {
      const cohortPurchaseAmount = purchase.receiptAmount === null || purchase.returnAmount === null
        ? null : purchase.receiptAmount - purchase.returnAmount;
      supplier.row.cohortPurchases = addAmount(supplier.row.cohortPurchases, cohortPurchaseAmount);
    }
  }

  for (const fact of sales.dataQuality.valuation) {
    const sourceStore = sourceStores.get(fact.sourceStoreKey);
    const city = sourceStore?.city ?? "Без города";
    const physicalStoreKey = sourceStore?.physicalKey ?? `key:${fact.sourceStoreKey}`;
    const candidate = candidatesByPair.get(JSON.stringify([fact.period, fact.sourceStoreKey, fact.itemKey]));
    const supplierCandidates = candidate?.supplierCandidates ?? [];
    const unknownSupplierLines = candidate?.unknownSupplierLines ?? 0;
    const reason: SupplierIncomeReason = unknownSupplierLines > 0 ? "unknown-supplier"
      : supplierCandidates.length > 1 ? "multiple-suppliers"
      : supplierCandidates.length === 1 ? "unique" : "no-purchase";
    const assignedKey = reason === "unique" ? supplierCandidates[0] : null;
    const metadata = assignedKey === null ? undefined : supplierMetadata.get(assignedKey);
    attribution.push({ period: fact.period, sourceStoreKey: fact.sourceStoreKey, physicalStoreKey, city,
      itemKey: fact.itemKey, quantity: fact.quantity, revenue: fact.revenue, absoluteQuantity: fact.absoluteQuantity,
      unitCost: fact.unitCost, costSource: fact.source, valuedCost: fact.valuedCost,
      supplierKey: assignedKey, supplierName: assignedKey === null ? null : metadata?.supplierName ?? assignedKey,
      supplierCandidates, unknownSupplierLines, reason });
    if (assignedKey !== null) {
      const supplier = ensureSupplier(fact.period, city, assignedKey);
      addIncome(supplier.income, fact);
      if (selectedPhysicalStores.has(physicalStoreKey)) addIncome(supplier.cohortIncome, fact);
    } else {
      const residualReason = reason as Exclude<SupplierIncomeReason, "unique">;
      const residualKey = JSON.stringify([fact.period, city, residualReason]);
      let accumulator = residual.get(residualKey);
      if (!accumulator) {
        accumulator = { period: fact.period, city, reason: residualReason, pairCount: 0, income: newIncome() };
        residual.set(residualKey, accumulator);
      }
      accumulator.pairCount += 1;
      addIncome(accumulator.income, fact);
    }
  }

  const supplierRows: PresentationSupplier[] = [...suppliers.values()].map(({ row, income, cohortIncome }) => ({
    ...row, ...incomeMetrics(income, salesAvailable[row.period]),
    cohortEstimatedGrossIncome: hasCohort
      ? incomeMetrics(cohortIncome, salesAvailable[row.period]).estimatedGrossIncome : null
  }));
  supplierRows.sort((a, b) => periodOrder[a.period] - periodOrder[b.period]
    || a.city.localeCompare(b.city, "ru") || a.supplierName.localeCompare(b.supplierName, "ru")
    || a.supplierKey.localeCompare(b.supplierKey));
  const residualRows: SupplierIncomeResidual[] = [...residual.values()].map((row) => ({
    period: row.period, city: row.city, reason: row.reason, pairCount: row.pairCount,
    ...incomeMetrics(row.income, salesAvailable[row.period])
  }));
  residualRows.sort((a, b) => periodOrder[a.period] - periodOrder[b.period]
    || a.city.localeCompare(b.city, "ru") || a.reason.localeCompare(b.reason));
  return { suppliers: supplierRows, residual: residualRows, attribution, purchasingQuality: purchasing.quality };
}
