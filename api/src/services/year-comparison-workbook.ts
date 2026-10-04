import ExcelJS from "exceljs";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { comparisonMembers } from "./year-comparison.js";
import type { ComparisonAggregate, ComparisonPeriod, PeriodQuality, YearComparisonReport } from "./year-comparison.js";

const numberFormat = '#,##0.00;[Red](#,##0.00);"–"';
const quantityFormat = '#,##0.###;[Red](#,##0.###);"–"';
const percentFormat = '0.0%;[Red](0.0%);"–"';
const integerFormat = '#,##0;[Red](#,##0);"–"';
const unavailable = "n/a";
const businessSheets = [
  ["Категория пиво-энергетик", "combined"],
  ["Пивной напиток", "Пивной напиток"],
  ["пиво бут", "Пиво бут"],
  ["пиво жб", "Пиво жб"],
  ["пиво розлив", "Пиво розлив"],
  ["Разливные напитки", "Разливные напитки"],
  ["Энергетический напиток", "Энергетический напиток"]
] as const;

const readerGuide = [
  ["Темно-синие строки", "Заголовки столбцов и названия городов на листах долей. Цвет помогает ориентироваться, но не означает хороший или плохой результат."],
  ["Светло-голубые жирные строки", "Итоги по городу, выбранной сопоставимой сети или всем физическим точкам. В строке «Сопоставимая сеть» учитываются только точки, отмеченные звездочкой."],
  ["Красные числа в скобках", "Отрицательное значение: (125,00) означает −125,00. Это может быть снижение, возврат или отрицательное нетто значение. Цвет сам по себе не является оценкой эффективности."],
  ["Тире и n/a", "Тире «–» в числовой ячейке означает настоящий ноль. n/a означает отсутствие данных, неизвестную стоимость либо невозможность деления на ноль. n/a нельзя заменять нулем."],
  ["Звездочка *", "Точка включена в сопоставимую сеть именно этого файла. Автоматический выбор требует положительных продажных чеков в обоих периодах по всем товарам; ручной выбор задается пользователем. Это не доказательство даты открытия."],
  ["Разряды чисел", "Суммы и ВД показаны с двумя знаками после запятой, количество — до трех, чеки — целыми, проценты — с одним. Оформление округляет отображение; формулы используют сохраненные значения ячеек."],
  ["Группировка, фильтры и печать", "Кнопки +/− слева сворачивают детали, стрелки в заголовках фильтруют строки. Итоги не пересчитываются при обычной фильтрации или скрытии строк. Первый столбец и верхние строки закреплены. Дата в нижнем колонтитуле — дата печати, не дата данных."],
  ["Периоды", "Запись [2026-04-01, 2026-07-01) означает 1 апреля — 30 июня включительно; 1 июля исключено. Предыдущий период использует те же календарные границы годом ранее. Время чеков сохраняет бизнес-календарь 1С."],
  ["B–E: количество и сумма", "B/C — нетто количество и сумма предыдущего периода; D/E — текущего. Продажи увеличивают значения, возвраты уменьшают. Суммы содержат записанный в 1С НДС. Количество сохраняет исходные единицы, включая услуги; это не единые штуки или литры."],
  ["F–G: абсолютная разница", "F = D − B, G = E − C. Положительное значение означает, что текущая величина больше предыдущей; отрицательное — меньше. Это изменение исходных единиц или тенге, не процент."],
  ["H–I: относительное изменение", "H = D / B − 1, I = E / C − 1. Например, переход со 100 до 120 дает 20%. Если предыдущая величина равна нулю или недоступна, результат n/a. При отрицательной базе процент требует отдельной интерпретации."],
  ["J–K: ВД, оценка", "J — предыдущий период, K — текущий. ВД = нетто сумма строк − оценочная стоимость нетто количества. Это не бухгалтерская прибыль или фактическая историческая себестоимость. Если существенное количество не оценено, ВД всего затронутого агрегата — n/a."],
  ["L: ВД, %", "L = K / J − 1: изменение оценочного ВД между периодами. Это НЕ доля ВД в выручке и НЕ показатель рентабельности. При нулевой или неизвестной базе — n/a."],
  ["M–O: чеки", "M/N — уникальные положительные продажные чеки предыдущего/текущего периода с товаром данного листа; возвратные чеки не входят. Один чек с несколькими категориями входит в каждую категорию, но в объединенной группе считается один раз. O = N / M − 1."],
  ["P–R: количество на чек", "P = B / M, Q = D / N, R = Q / P − 1. Числитель содержит нетто количество с учетом возвратов, знаменатель — положительные продажные чеки. Средние города и сети рассчитываются из общих величин, а не суммой средних точек."],
  ["S–U: сумма на чек", "S = C / M, T = E / N, U = T / S − 1. На категорийном листе это нетто сумма именно категории на ее продажной чек, а не средняя полная сумма всех товаров документа."],
  ["Итоги по строкам", "«Итого город» включает его физические точки; «Итого все физические точки» — все показанные точки. Сопоставимая сеть является отдельной выборкой: ее нельзя прибавлять к общему итогу. Чеки разных категорий также нельзя складывать из-за пересечений."],
  ["Доли продажи общие", "Только текущий период. Для каждого города категория определяется корневой папкой товаров. Доля количества, суммы или ВД = величина категории / итог соответствующего столбца этого города. Это не изменение год к году."],
  ["Доли продаж внутри группы", "Только текущий период; знаменатель — итог показанных членов группы этого города, не вся выручка сети. Входят шесть категорий сравнения, «Мульти пак» и подходящие «Прочие в группе». Доли используют нетто значения: при возвратах возможны отрицательные доли или более 100%."],
  ["Источник продаж", "Исходные документы 1С «Чек ККМ» и их строки «Товары», синхронизированные в PostgreSQL: document_chek_kkm и document_chek_kkm_tovary. Берутся проведенные, неудаленные документы с ненулевой суммой. Excel не извлекает числа из ручной книги и не подключается к 1С при открытии."],
  ["Справочники и объединение точек", "Названия магазинов — catalog_magaziny, товаров и папок — catalog_nomenklatura. Разные юридические ключи объединяются только по точно нормализованному адресу от «г.». Стоимость считается по исходным ключам до объединения. Текущая классификация не доказывает историческую принадлежность."],
  ["Состав объединенной категории", "Шесть членов: «Пивной напиток», «Пиво бут», «Пиво жб», «Пиво розлив», «Разливные напитки», «Энергетический напиток». «Мульти пак» не входит в объединенную категорию, но есть в долях внутри группы. Сумма этой категории не равна общей выручке всех товаров."],
  ["Как выбирается цена стоимости", "Для каждого периода отдельно, строго до его правой границы: 1) последний активный регистр магазина; 2) последний документ стоимости магазина; 3) последняя цена товара из документов по всей сети без ограничения магазина; 4) взвешенная закупочная цена за предыдущие 90 дней. Это порядок приоритета, не выбор самого нового источника среди всех четырех."],
  ["Оценочная стоимость", "Нетто количество товара исходного магазина умножается на выбранную цену; затем результаты суммируются. Возвраты уменьшают стоимость. В запасном закупочном расчете цена = сумма (сумма строки − НДС строки) / сумма количества. НДС из розничной выручки при расчете ВД не вычитается."],
  ["Коды цены на листе «Оценка стоимости»", "live-store-register — регистр магазина; store-cost-document — документ магазина; global-cost-document — документы по всей сети; purchase-90d — взвешенная закупка за 90 дней; unavailable — подходящей цены нет. current означает текущий период, previous — предыдущий."],
  ["Качество данных: покрытие", "«Дней с чеками» показывает дни с наблюдаемыми документами; полный календарь дней не доказывает полноту загрузки. «Документов чеков» включает продажи и возвраты всех товаров и поэтому отличается от M/N на категорийных листах."],
  ["Качество данных: сверка сумм", "«Строки минус заголовки» = нетто сумма товарных строк − нетто сумма заголовков документов. Расхождение показано отдельно; оно не распределяется по товарам. «ВД всего периода» относится ко всем товарам, а не только к объединенной категории."],
  ["Качество данных: неизвестная стоимость", "Абсолютное количество суммирует модули исходных количеств, не погашая продажи возвратами. Неоцененное количество входит в него. Доля оцененного количества = 1 − неоцененное / абсолютное. «Известная часть стоимости» не является полной стоимостью при наличии пробелов."],
  ["Где искать первоисточник числа", "«Магазины» связывает физическую точку с исходными ключами; «Классификация» связывает товар с категорией; «Оценка стоимости» хранит период, исходный магазин, товар, количество, сумму, цену и источник цены. Длинные ключи — идентификаторы, не суммы и не ошибки."],
  ["Проверка и обновление", "Выберите ячейку: в строке формул виден расчет либо готовое число SQL-снимка. При изменении 1С нужно дождаться синхронизации и сформировать файл заново. Этот файл не обновляет первичные данные сам; ручное изменение ячеек не пересчитывает состав чеков или сопоставимой сети."]
] as const;

// ExcelJS types omit the streaming worksheet's public commit method.
type StreamingWorksheet = ExcelJS.Worksheet & { commit(): void };

function worksheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, widths: number[], freezeRows = 3) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", xSplit: 1, ySplit: freezeRows }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    // Explicit outlineProperties makes ExcelJS emit outlinePr after pageSetUpPr,
    // violating OOXML child order. Default summary placement already fits these rows.
    properties: { defaultRowHeight: 21 }
  }) as StreamingWorksheet;
  sheet.columns = widths.map((width) => ({ width }));
  sheet.pageSetup.printTitlesRow = `1:${freezeRows}`;
  sheet.headerFooter.oddFooter = "&LНалив — аналитика&C&P / &N&R&D";
  return sheet;
}

function header(row: ExcelJS.Row) {
  row.height = 34;
  row.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF24475B" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function body(row: ExcelJS.Row, subtotal = false) {
  row.eachCell((cell, column) => {
    cell.font = { name: "Calibri", size: 11, bold: subtotal };
    cell.alignment = { vertical: "middle", horizontal: column === 1 ? "left" : "right", wrapText: column === 1 };
    cell.border = { bottom: { style: "hair", color: { argb: "FFD9E2E8" } } };
    if (subtotal) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3EDF2" } };
  });
}

function formula(cell: ExcelJS.Cell, expression: string, result: number | null) {
  cell.value = { formula: expression, result: result ?? unavailable };
}

function change(row: ExcelJS.Row, destination: number, previous: number, current: number, relative: boolean) {
  const oldCell = row.getCell(previous);
  const newCell = row.getCell(current);
  const old = typeof oldCell.value === "number" ? oldCell.value : oldCell.result;
  const next = typeof newCell.value === "number" ? newCell.value : newCell.result;
  const value = typeof old === "number" && typeof next === "number" && (!relative || old !== 0)
    ? relative ? next / old - 1 : next - old : null;
  const guard = `AND(ISNUMBER(${oldCell.address}),ISNUMBER(${newCell.address})${relative ? `,${oldCell.address}<>0` : ""})`;
  formula(row.getCell(destination), `IF(${guard},${newCell.address}${relative ? "/" : "-"}${oldCell.address}${relative ? "-1" : ""},"n/a")`, value);
}

function sumCell(row: ExcelJS.Row, column: number, sourceRows: number[], result: number | null) {
  if (result === null || !sourceRows.length) {
    row.getCell(column).value = result ?? unavailable;
    return;
  }
  const letter = row.getCell(column).address.replace(/\d+$/, "");
  formula(row.getCell(column), `SUM(${sourceRows.map((source) => `${letter}${source}`).join(",")})`, result);
}

export async function writeYearComparisonWorkbook(report: YearComparisonReport, output: Writable) {
  if (output.destroyed) throw new Error("Excel download was closed");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output, useStyles: true, useSharedStrings: true,
    zip: { zlib: { level: 9 } }
  });
  // Archiver is a public runtime property omitted by ExcelJS declarations.
  const archive = (workbook as ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void } }).zip;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => {
    if (!output.writableFinished) canceled.abort(new Error("Excel download was closed"));
  };
  output.once("error", onError);
  output.once("close", onClose);
  archive.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  try {
    workbook.creator = "Налив — аналитика";
    workbook.created = new Date(report.generatedAt);
    workbook.modified = workbook.created;
    const aggregateIndex = new Map<string, ComparisonAggregate>();
    for (const aggregate of report.aggregates) {
      aggregateIndex.set(JSON.stringify([aggregate.period, aggregate.scope, aggregate.scopeKey, aggregate.groupKind, aggregate.groupKey]), aggregate);
    }
    const lookup = (period: ComparisonPeriod, scope: ComparisonAggregate["scope"], scopeKey: string, kind: ComparisonAggregate["groupKind"], group: string) =>
      aggregateIndex.get(JSON.stringify([period, scope, scopeKey, kind, group]));
    const cities = [...new Set(report.stores.map((store) => store.city))].sort((a, b) => a.localeCompare(b, "ru"));
    const selected = new Set(report.cohort.selectedStoreKeys);
    const previousLabel = `[${report.periods.previous.from}, ${report.periods.previous.to})`;
    const currentLabel = `[${report.periods.current.from}, ${report.periods.current.to})`;

    for (const [name, group] of businessSheets) {
      const sheet = worksheet(workbook, name, [43, ...Array<number>(20).fill(18)]);
      sheet.mergeCells("A1:U1");
      sheet.getCell("A1").value = `${name} — нетто продажи; ВД оценочный, с ограничениями стоимости`;
      sheet.getCell("A1").font = { name: "Calibri", size: 14, bold: true };
      sheet.getCell("A1").alignment = { wrapText: true, vertical: "middle" };
      sheet.getRow(1).height = 35;
      sheet.getRow(2).values = ["Физическая точка / город", previousLabel, "", currentLabel, "", "Разница", "", "Разница, %", "", "ВД, оценка", "", "ВД, %", "Чеки продаж", "", "Чеки, %", "Количество / чек", "", "Изменение, %", "Сумма / чек", "", "Изменение, %"];
      for (const [from, to] of [[2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [13, 14], [16, 17], [19, 20]]) sheet.mergeCells(2, from, 2, to);
      sheet.getRow(3).values = ["Выбранная сеть отмечена *", "кол-во", "сумма с НДС", "кол-во", "сумма с НДС", "кол-во", "сумма", "кол-во", "сумма", "предыдущий", "текущий", "изменение", "предыдущий", "текущий", "изменение", "предыдущий", "текущий", "изменение", "предыдущий", "текущий", "изменение"];
      header(sheet.getRow(2));
      header(sheet.getRow(3));
      const cityRows: number[] = [];
      const selectedRows: number[] = [];

      const addComparisonRow = (label: string, previous: ComparisonAggregate | undefined, current: ComparisonAggregate | undefined, subtotal: boolean, sourceRows: number[] = []) => {
        const row = sheet.addRow([
          label, previous?.quantity ?? unavailable, previous?.revenue ?? unavailable,
          current?.quantity ?? unavailable, current?.revenue ?? unavailable,
          null, null, null, null, previous?.estimatedGrossIncome ?? unavailable, current?.estimatedGrossIncome ?? unavailable,
          null, previous?.receiptCount ?? unavailable, current?.receiptCount ?? unavailable, null,
          null, null, null, null, null, null
        ]);
        if (subtotal) {
          for (const [column, value] of [
            [2, previous?.quantity], [3, previous?.revenue], [4, current?.quantity], [5, current?.revenue],
            [10, previous?.estimatedGrossIncome], [11, current?.estimatedGrossIncome]
          ] as const) sumCell(row, column, sourceRows, value ?? null);
        }
        // Counts are snapshot DISTINCT aggregates, never sums of member categories.
        for (const [destination, previousColumn, currentColumn, relative] of [
          [6, 2, 4, false], [7, 3, 5, false], [8, 2, 4, true], [9, 3, 5, true],
          [12, 10, 11, true], [15, 13, 14, true]
        ] as const) change(row, destination, previousColumn, currentColumn, relative);
        for (const [destination, numerator, denominator, value] of [
          [16, 2, 13, previous?.avgQuantityPerReceipt], [17, 4, 14, current?.avgQuantityPerReceipt],
          [19, 3, 13, previous?.avgAmountPerReceipt], [20, 5, 14, current?.avgAmountPerReceipt]
        ] as const) {
          const n = row.getCell(numerator).address;
          const d = row.getCell(denominator).address;
          formula(row.getCell(destination), `IF(AND(ISNUMBER(${n}),ISNUMBER(${d}),${d}<>0),${n}/${d},"n/a")`, value ?? null);
        }
        change(row, 18, 16, 17, true);
        change(row, 21, 19, 20, true);
        body(row, subtotal);
        for (const column of [2, 4, 6, 16, 17]) row.getCell(column).numFmt = quantityFormat;
        for (const column of [3, 5, 7, 10, 11, 19, 20]) row.getCell(column).numFmt = numberFormat;
        for (const column of [8, 9, 12, 15, 18, 21]) row.getCell(column).numFmt = percentFormat;
        for (const column of [13, 14]) row.getCell(column).numFmt = integerFormat;
        return row.number;
      };

      for (const city of cities) {
        const storeRows: number[] = [];
        for (const store of report.stores.filter((value) => value.city === city)) {
          const row = addComparisonRow(`${selected.has(store.key) ? "* " : ""}${store.name}`,
            lookup("previous", "store", store.key, "comparison", group), lookup("current", "store", store.key, "comparison", group), false);
          sheet.getRow(row).outlineLevel = 1;
          storeRows.push(row);
          if (selected.has(store.key)) selectedRows.push(row);
        }
        cityRows.push(addComparisonRow(`Итого ${city}`, lookup("previous", "city", city, "comparison", group), lookup("current", "city", city, "comparison", group), true, storeRows));
      }
      sheet.addRow([]);
      addComparisonRow(`Сопоставимая сеть (${report.cohort.mode === "observed" ? "по активности" : "ручной выбор"})`,
        lookup("previous", "cohort", "cohort", "comparison", group), lookup("current", "cohort", "cohort", "comparison", group), true, selectedRows);
      addComparisonRow("Итого все физические точки", lookup("previous", "all", "all", "comparison", group), lookup("current", "all", "all", "comparison", group), true, cityRows);
      sheet.autoFilter = { from: "A3", to: `U${Math.max(3, sheet.lastRow!.number - 3)}` };
      sheet.pageSetup.printArea = `A1:U${sheet.lastRow!.number}`;
      sheet.commit();
    }

    const rootNames = new Map(report.dataQuality.taxonomy.map((item) => [item.rootKey, item.rootName]));
    for (const [name, kind] of [["Доли продажи общие", "root"], ["Доли продаж внутри группы", "within"]] as const) {
      const sheet = worksheet(workbook, name, [43, 20, 23, 23, 19, 19, 19]);
      sheet.mergeCells("A1:G1");
      sheet.getCell("A1").value = `${name} — ${currentLabel}; доли нетто значений, ВД оценочный`;
      sheet.getCell("A1").font = { name: "Calibri", size: 14, bold: true };
      sheet.getRow(1).height = 35;
      sheet.getRow(2).values = ["Город / категория", "Количество", "Сумма с НДС", "ВД, оценка", "Доля количества", "Доля суммы", "Доля ВД"];
      header(sheet.getRow(2));
      sheet.getRow(3).values = ["Проценты = нетто значение / нетто итог; знаменатель 0 или неизвестный ВД — n/a"];
      sheet.mergeCells("A3:G3");
      sheet.getCell("A3").alignment = { wrapText: true };
      sheet.getRow(3).height = 32;
      for (const city of cities) {
        const values = report.aggregates.filter((aggregate) => aggregate.period === "current" && aggregate.scope === "city" && aggregate.scopeKey === city && aggregate.groupKind === kind);
        const groups = kind === "within"
          ? [...new Set([...comparisonMembers, "Мульти пак", ...values.map((value) => value.groupKey)])]
          : values.map((value) => value.groupKey).sort((a, b) => (rootNames.get(a) ?? a).localeCompare(rootNames.get(b) ?? b, "ru"));
        const cityRow = sheet.addRow([city]);
        sheet.mergeCells(cityRow.number, 1, cityRow.number, 7);
        header(cityRow);
        const rowNumbers: number[] = [];
        for (const key of groups) {
          const value = lookup("current", "city", city, kind, key);
          const row = sheet.addRow([kind === "root" ? rootNames.get(key) ?? key : key,
            value?.quantity ?? unavailable, value?.revenue ?? unavailable, value?.estimatedGrossIncome ?? unavailable, null, null, null]);
          row.outlineLevel = 1;
          rowNumbers.push(row.number);
          body(row);
        }
        if (!groups.length) sheet.addRow(["Нет наблюдаемых строк", unavailable, unavailable, unavailable]);
        const total = sheet.addRow([`Итого ${city}`, null, null, null, null, null, null]);
        const quantity = values.length ? values.reduce((sum, value) => sum + value.quantity, 0) : null;
        const revenue = values.length ? values.reduce((sum, value) => sum + value.revenue, 0) : null;
        const income = values.length && values.every((value) => value.estimatedGrossIncome !== null)
          ? values.reduce((sum, value) => sum + value.estimatedGrossIncome!, 0) : null;
        for (const [column, value] of [[2, quantity], [3, revenue], [4, income]] as const) sumCell(total, column, rowNumbers, value);
        for (const rowNumber of [...rowNumbers, total.number]) {
          const row = sheet.getRow(rowNumber);
          for (const [destination, source, denominator] of [[5, 2, quantity], [6, 3, revenue], [7, 4, income]] as const) {
            const n = row.getCell(source);
            const d = total.getCell(source).address;
            const numerator = typeof n.value === "number" ? n.value : n.result;
            formula(row.getCell(destination), `IF(AND(ISNUMBER(${n.address}),ISNUMBER(${d}),${d}<>0),${n.address}/${d},"n/a")`,
              typeof numerator === "number" && denominator !== null && denominator !== 0 ? numerator / denominator : null);
            row.getCell(destination).numFmt = percentFormat;
          }
          row.getCell(2).numFmt = quantityFormat;
          row.getCell(3).numFmt = numberFormat;
          row.getCell(4).numFmt = numberFormat;
        }
        body(total, true);
        sheet.addRow([]);
      }
      sheet.pageSetup.printArea = `A1:G${sheet.lastRow!.number}`;
      sheet.commit();
    }

    const methodology = worksheet(workbook, "Методология", [7, 125], 2);
    methodology.mergeCells("A1:B1");
    methodology.getCell("A1").value = `Год к году: ${currentLabel} против ${previousLabel}`;
    methodology.getCell("A1").font = { size: 14, bold: true };
    methodology.addRow(["№", "Метод, источники и ограничения"]);
    header(methodology.getRow(2));
    for (const [index, text] of report.methodology.entries()) {
      const row = methodology.addRow([index + 1, text]);
      row.height = 65;
      row.getCell(2).alignment = { wrapText: true, vertical: "middle" };
    }
    methodology.addRow(["Снимок UTC", report.generatedAt]);
    methodology.addRow(["Текущий расчет стоимости до", report.periods.current.to]);
    methodology.addRow(["Предыдущий расчет стоимости до", report.periods.previous.to]);
    methodology.addRow([]);
    const guideHeader = methodology.addRow(["Как читать отчет: оформление, показатели и источники"]);
    methodology.mergeCells(guideHeader.number, 1, guideHeader.number, 2);
    header(guideHeader);
    for (const [index, [topic, text]] of readerGuide.entries()) {
      const row = methodology.addRow([index + 1, `${topic}. ${text}`]);
      row.height = 80;
      row.getCell(2).alignment = { wrapText: true, vertical: "middle" };
    }
    methodology.commit();

    const quality = worksheet(workbook, "Качество данных", [53, 38, 38], 2);
    quality.addRow(["Наблюдаемое покрытие и сверка", currentLabel, previousLabel]);
    quality.addRow(["Показатель", "Текущий период", "Предыдущий период"]);
    header(quality.getRow(1));
    header(quality.getRow(2));
    const coverageByPeriod = Object.fromEntries(report.coverage.map((value) => [value.period, value]));
    const qualityByPeriod = Object.fromEntries(report.dataQuality.periods.map((value) => [value.period, value]));
    for (const [label, key] of [["Дней с чеками", "coveredDays"], ["Ожидается календарных дней", "expectedDays"], ["Документов чеков", "receiptCount"], ["Статус наблюдения", "status"], ["Первая наблюдаемая дата", "dateFrom"], ["Последняя наблюдаемая дата", "dateTo"]] as const) {
      quality.addRow([label, coverageByPeriod.current[key] ?? unavailable, coverageByPeriod.previous[key] ?? unavailable]);
    }
    for (const [label, key] of [
      ["Нетто сумма заголовков с НДС", "headerRevenue"], ["Нетто сумма строк с НДС", "lineRevenue"], ["Строки минус заголовки", "difference"],
      ["Положительные продажные чеки DISTINCT", "positiveSaleReceiptCount"], ["Чеки возврата", "returnReceiptCount"], ["Чеки без строк", "receiptsWithoutLines"],
      ["Строки чеков", "lineCount"], ["Абсолютное количество строк", "absoluteQuantity"], ["Количество без стоимости (абсолютное)", "unvaluedQuantity"],
      ["Известная часть оценочной стоимости", "valuedCost"], ["Нетто выручка строк без стоимости", "unvaluedRevenue"], ["ВД всего периода, оценка", "estimatedGrossIncome"]
    ] satisfies [string, keyof PeriodQuality][]) {
      const row = quality.addRow([label, qualityByPeriod.current[key] ?? unavailable, qualityByPeriod.previous[key] ?? unavailable]);
      row.getCell(2).numFmt = numberFormat;
      row.getCell(3).numFmt = numberFormat;
    }
    const costCoverageRow = quality.addRow(["Доля оцененного абсолютного количества"]);
    for (const [column, period] of [[2, "current"], [3, "previous"]] as const) {
      const value = qualityByPeriod[period];
      costCoverageRow.getCell(column).value = value.absoluteQuantity > 0 ? 1 - value.unvaluedQuantity / value.absoluteQuantity : unavailable;
      costCoverageRow.getCell(column).numFmt = percentFormat;
    }
    quality.addRow([]);
    quality.addRow(["Глобальная история подходящих чеков", report.dataQuality.global.dateFrom ?? unavailable, report.dataQuality.global.dateTo ?? unavailable]);
    quality.addRow(["Глобально дней с подходящими чеками", report.dataQuality.global.coveredDays]);
    quality.addRow(["Важно", "Наблюдение активности не доказывает полноту загрузки"]);
    quality.addRow([]);
    const missingHeader = quality.addRow(["Даты без наблюдаемых чеков", "Текущий период", "Предыдущий период"]);
    header(missingHeader);
    for (let index = 0; index < Math.max(coverageByPeriod.current.missingDays.length, coverageByPeriod.previous.missingDays.length); index++) {
      quality.addRow([index + 1, coverageByPeriod.current.missingDays[index] ?? "", coverageByPeriod.previous.missingDays[index] ?? ""]);
    }
    quality.commit();

    const stores = worksheet(workbook, "Магазины", [31, 53, 29, 20, 20, 42, 62], 2);
    stores.addRow(["Сеть", report.cohort.mode === "observed" ? "Автоматическая: активность в обоих окнах" : "Ручной выбор", "Выбранных точек", selected.size]);
    stores.addRow(["Физический ключ", "Название / адрес", "Город", "Активен в обоих", "Выбран в сеть", "Исходный ключ 1С", "Исходное название"]);
    header(stores.getRow(2));
    const storeIndex = new Map(report.stores.map((store) => [store.key, store]));
    for (const source of report.dataQuality.sourceStores) {
      const store = storeIndex.get(source.physicalKey)!;
      stores.addRow([store.key, store.name, store.city, store.comparableByActivity, selected.has(store.key), source.key, source.name]);
    }
    stores.autoFilter = { from: "A2", to: `G${stores.lastRow!.number}` };
    stores.commit();

    const taxonomy = worksheet(workbook, "Классификация", [42, 60, 42, 34, 33, 34, 72, 21, 23, 21, 23], 2);
    taxonomy.addRow(["Текущая классификация 1С; не историческая. Несопоставленные строки сохраняются в общих долях."]);
    taxonomy.mergeCells("A1:K1");
    taxonomy.addRow(["Ключ товара", "Название", "Ключ корневой папки", "Корень", "Член группы", "Проблема", "Путь ключей (товар → корень)", "Кол-во текущее", "Сумма текущая", "Кол-во предыдущее", "Сумма предыдущая"]);
    header(taxonomy.getRow(2));
    taxonomy.autoFilter = { from: "A2", to: `K${report.dataQuality.taxonomy.length + 2}` };
    for (const item of report.dataQuality.taxonomy) {
      const row = taxonomy.addRow([item.itemKey, item.name, item.rootKey, item.rootName, item.member ?? unavailable, item.issue ?? "", item.path.join(" → "), item.currentQuantity, item.currentRevenue, item.previousQuantity, item.previousRevenue]);
      for (const column of [8, 10]) row.getCell(column).numFmt = quantityFormat;
      for (const column of [9, 11]) row.getCell(column).numFmt = numberFormat;
      row.commit();
      if (row.number % 256 === 0) {
        await setImmediate();
        if (canceled.signal.aborted) throw canceled.signal.reason;
      }
    }
    taxonomy.commit();

    const valuation = worksheet(workbook, "Оценка стоимости", [17, 21, 42, 42, 25, 30, 21, 23, 23, 23], 2);
    valuation.addRow(["Оценка по исходным ключам, до объединения магазинов. Не фактический исторический COGS."]);
    valuation.mergeCells("A1:J1");
    valuation.addRow(["Окно", "Граница (исключена)", "Исходный магазин", "Товар", "Цена, оценка", "Источник цены", "Количество нетто", "Сумма с НДС", "Абсолютное количество", "Оценочная стоимость"]);
    header(valuation.getRow(2));
    valuation.autoFilter = { from: "A2", to: `J${report.dataQuality.valuation.length + 2}` };
    for (const value of report.dataQuality.valuation) {
      const row = valuation.addRow([value.period, report.periods[value.period].to, value.sourceStoreKey, value.itemKey,
        value.unitCost ?? unavailable, value.source, value.quantity, value.revenue, value.absoluteQuantity, value.valuedCost ?? unavailable]);
      for (const column of [5, 8, 10]) row.getCell(column).numFmt = numberFormat;
      for (const column of [7, 9]) row.getCell(column).numFmt = quantityFormat;
      row.commit();
      if (row.number % 256 === 0) {
        await setImmediate();
        if (canceled.signal.aborted) throw canceled.signal.reason;
      }
    }
    valuation.commit();
    await Promise.race([workbook.commit(), interrupted]);
    if (canceled.signal.aborted) throw canceled.signal.reason;
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    output.off("error", onError);
    output.off("close", onClose);
    archive.off("error", onError);
    canceled.abort();
  }
}
