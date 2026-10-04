import type { Prisma as PrismaClientTypes } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma.js";
import type { PresentationReport, PresentationReportParams } from "./presentation-report-types.js";
import { getPresentationSupplierData } from "./presentation-suppliers.js";
import { getYearComparison, yearComparisonQuerySchema } from "./year-comparison.js";

const dayMilliseconds = 86_400_000;

function validateWindow(from: string, to: string, context: z.RefinementCtx, detail: boolean) {
  const parsed = yearComparisonQuerySchema.safeParse({ from, to, cohort: "observed", comparableStore: [] });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        ...issue,
        path: issue.path.map((part) => detail && (part === "from" || part === "to")
          ? part === "from" ? "monthFrom" : "monthTo"
          : part)
      });
    }
  }
}

export const presentationReportQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
  monthFrom: z.string().optional(),
  monthTo: z.string().optional(),
  city: z.union([z.string(), z.array(z.string())]).optional()
    .transform((value) => [...new Set((typeof value === "string" ? [value] : value ?? [])
      .map((city) => city.trim()).filter(Boolean))].sort())
}).superRefine((value, context) => {
  validateWindow(value.from, value.to, context, false);
  if ((value.monthFrom === undefined) !== (value.monthTo === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      path: [value.monthFrom === undefined ? "monthFrom" : "monthTo"],
      message: "Дополнительный период требует обе границы monthFrom и monthTo" });
  } else if (value.monthFrom !== undefined && value.monthTo !== undefined) {
    validateWindow(value.monthFrom, value.monthTo, context, true);
  }
}).transform((value): PresentationReportParams => {
  const lastDay = new Date(Date.parse(`${value.to}T00:00:00Z`) - dayMilliseconds);
  const firstDayOfLastMonth = `${lastDay.toISOString().slice(0, 7)}-01`;
  return {
    from: value.from,
    to: value.to,
    monthFrom: value.monthFrom ?? (value.from > firstDayOfLastMonth ? value.from : firstDayOfLastMonth),
    monthTo: value.monthTo ?? value.to,
    city: value.city
  };
});

export type PresentationReportInput = z.input<typeof presentationReportQuerySchema>;

const presentationMethodology = [
  "Это отдельный презентационный отчет. Основной и дополнительный периоды независимы; границы [from,to) исключают правую дату. Предыдущие окна имеют те же календарные границы годом ранее. Ни год, ни месяц не зафиксированы в расчетах.",
  "Фильтр городов применяется только к отображению/экспорту. Расчетные блоки, исходные пары, источники и аудит качества содержат всю сеть, в том числе невыбранные города; это полный сетевой аудит, не аудит отфильтрованного фрагмента.",
  "Поступления и возвраты поставщикам — проведенные, неудаленные документы внутри соответствующего окна. Закупки = записанные суммы заголовков поступлений минус модули сумм заголовков возвратов поставщикам; знак возврата нормализуется один раз. Отсутствующая сумма документа делает итог недоступным, но реальная сумма 0 сохраняется.",
  "Закупочные суммы сохраняют записанную в 1С семантику НДС: это суммы документов, не объявленная выручка или закупки без НДС. Сверка поступлений со строками использует записанное поле сумма строк без вычитания НДС; правила включения НДС могут объяснять расхождение. Отсутствующие строки или суммы не превращаются в ноль.",
  "Город закупки определяется по принимающему магазину документа, иначе по магазину склада; неизвестная связь дает «Без города». Город дохода MODEL определяется по исходному магазину продаж. Эти города не отождествляются без связи с магазином.",
  "Доход поставщика — MODEL уникального закупочного поставщика, не фактическая бухгалтерская прибыль поставщика и не доказанное происхождение проданной партии. Для каждой исходной пары магазин × товар учитываются только положительные по количеству строки поступлений в том же окне. Единственный непустой, ненулевой поставщик и отсутствие строк с неизвестным поставщиком разрешают атрибуцию; будущие и внепериодные поступления исключены.",
  "Модель не использует текущего основного поставщика товара. Все фактические поставщики поступлений и возвратов, включая поставщиков только закупок или только возвратов, сохраняются без top-N. Пустой/нулевой поставщик не создается как вымышленный контрагент; его документы остаются в сетевом качестве данных.",
  "Каждая исходная оценочная пара продаж попадает ровно одному поставщику либо в отдельный остаток: неизвестный поставщик имеет приоритет, затем несколько поставщиков, затем отсутствие подходящей закупки. Аудит сохраняет все исходные пары, кандидатов и число строк неизвестного поставщика. Остаток не распределяется пропорционально и не скрывается.",
  "Оценочный ВД MODEL использует ту же исходную оценку стоимости магазина, что продажи, до объединения физических точек. Полный ВД недоступен при неизвестной стоимости материального абсолютного количества (>1e-9); известный оценочный ВД — отдельно обозначенное подмножество, не полный итог. Выручка и известный ВД поставщиков вместе с остатком сверяются с исходными продажами. Покрытие атрибуции выручки не доказывает покрытие ВД.",
  "Сопоставимые закупки и ВД MODEL используют только исходные магазины, связанные с выбранными физическими точками автоматической сопоставимой сети для данного окна. При пустой сопоставимой сети показатели n/a, не 0. Положительные продажи в обоих окнах — признак наблюдаемой активности, не доказательство даты открытия.",
  "Совпадение непустого ИНН поставщика с ИНН организации — только флаг возможного внутреннего контрагента. Такие документы и поставщики не исключаются автоматически.",
  "Глобальные даты поступлений и даты документов каждого окна показывают доступную историю, а не доказанную полноту загрузки. Неполная или отсутствующая история прошлого года не запрещает экспорт: недоступные сравнения и рост должны показываться n/a с предупреждением. Открытие точек по этим источникам не подтверждено.",
  "Продажи обоих окон, поступления, возвраты и каталоги прочитаны в одном снимке Repeatable Read; JIT отключен на время транзакции. Переданный транзакционный клиент должен обеспечивать тот же уровень изоляции."
];

/** A supplied client is already a transaction owned by the caller. */
export async function getPresentationReport(
  input: PresentationReportInput,
  client?: PrismaClientTypes.TransactionClient
): Promise<PresentationReport> {
  const params = presentationReportQuerySchema.parse(input);
  const readReport = async (tx: PrismaClientTypes.TransactionClient): Promise<PresentationReport> => {
    await tx.$executeRaw`set local jit = off`;
    const readBlock = async (from: string, to: string) => {
      const sales = await getYearComparison({ from, to, cohort: "observed", comparableStore: [] },
        { presentationGroups: true, client: tx });
      return { sales, ...await getPresentationSupplierData(sales, tx) };
    };
    const main = await readBlock(params.from, params.to);
    const detail = params.from === params.monthFrom && params.to === params.monthTo
      ? main : await readBlock(params.monthFrom, params.monthTo);
    const methodology = [...main.sales.methodology, ...presentationMethodology];
    for (const [label, block] of [["Основной", main], ["Дополнительный", detail]] as const) {
      for (const coverage of block.sales.coverage) {
        const periodLabel = coverage.period === "current" ? "текущий" : "предыдущий";
        if (coverage.status === "empty") {
          methodology.push(`ВНИМАНИЕ: ${label} ${periodLabel} период не содержит подходящих продаж; показатели этого периода и рост по нему недоступны (n/a), а не равны 0.`);
        } else if (coverage.status === "partial") {
          methodology.push(`ВНИМАНИЕ: ${label} ${periodLabel} период содержит продажи только за ${coverage.coveredDays} из ${coverage.expectedDays} дней (${coverage.dateFrom} — ${coverage.dateTo}); полнота истории не подтверждена.`);
        }
      }
      if (!block.sales.cohort.selectedStoreKeys.length) {
        methodology.push(`ВНИМАНИЕ: ${label} период не имеет наблюдаемой сопоставимой сети; сопоставимые закупки и ВД MODEL недоступны (n/a). Даты открытия точек не подтверждены.`);
      }
      for (const quality of block.purchasingQuality) {
        if (quality.status !== "observed") {
          methodology.push(`ВНИМАНИЕ: ${label} период закупок (${quality.period}) имеет ${quality.status === "empty" ? "отсутствующую" : "частичную"} историю. Глобальная история поступлений: ${quality.sourceDateFrom ?? "n/a"} — ${quality.sourceDateTo ?? "n/a"}; суммы вне наблюдаемой истории не восстановлены.`);
        }
        if (quality.missingReceiptAmounts || quality.missingReturnAmounts) {
          methodology.push(`ВНИМАНИЕ: ${label} период закупок (${quality.period}) содержит неизвестные суммы: поступления ${quality.missingReceiptAmounts}, возвраты ${quality.missingReturnAmounts}; затронутые итоги закупок недоступны (n/a).`);
        }
        if (quality.receiptsWithoutLines) {
          methodology.push(`ВНИМАНИЕ: ${label} период закупок (${quality.period}) содержит ${quality.receiptsWithoutLines} поступлений без строк; полная сверка со строками и атрибуция этих товаров не подтверждены.`);
        }
        if (quality.documentLineDifference !== null && Math.abs(quality.documentLineDifference) > 1e-9) {
          methodology.push(`ВНИМАНИЕ: ${label} период закупок (${quality.period}): суммы заголовков поступлений минус записанные суммы строк = ${quality.documentLineDifference}; сверка не является сверкой сумм без НДС.`);
        }
      }
      for (const quality of block.sales.dataQuality.periods) {
        if (quality.unvaluedQuantity > 1e-9) {
          methodology.push(`ВНИМАНИЕ: ${label} период (${quality.period}) имеет неизвестную стоимость абсолютного количества ${quality.unvaluedQuantity} в смешанных единицах 1С; полный ВД недоступен, известный ВД — только подмножество.`);
        }
      }
      if (block.residual.length) {
        methodology.push(`ВНИМАНИЕ: ${label} период имеет неатрибутированный остаток MODEL. Его выручка и известный ВД сохранены отдельно по причине, городу и периоду; это не доход реального поставщика.`);
      }
    }
    return { generatedAt: main.sales.generatedAt, params, main, detail, methodology };
  };
  return client ? readReport(client) : prisma.$transaction(readReport, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 30_000,
    timeout: 240_000
  });
}
