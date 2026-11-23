const size = String.raw`(?: \d+(?:[.,]\d+)?(?: ?(?:мл|л))?)?`;
const plasticBottle = new RegExp(String.raw`^(?:пластиковая бутылка|бутылка пластиковая)${size}(?: с крышкой| \+ ручка)?$`, "iu");
const brandedCup = new RegExp(String.raw`^(?:стакан фирменный|фирменный стакан)(?: \(шейкер\)| одноразовый| со льдом(?: и крышкой)?)?${size}$`, "iu");
const brandedMaterialCup = new RegExp(String.raw`^(?:(?:двухслойный )?бумажный стакан(?: крафт)?|стакан пластик)${size} фирменный$`, "iu");
const brandedMaika = /^майка (?:фирменная|ч[её]рная налив)$/iu;

// Match standalone catalog names, not references to packaging in other merchandise.
export function isExcludedTurnoverItem(name: string | null | undefined): boolean {
  if (!name) return false;
  const title = name.trim().replace(/\s+/gu, " ");
  return plasticBottle.test(title) || brandedCup.test(title) || brandedMaterialCup.test(title) || brandedMaika.test(title);
}
