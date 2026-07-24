// Разовая правка данных: переставляет рубрики (categories) во всех кафе в базе
// так, чтобы основные блюда шли первыми, бар/напитки — вторыми, снеки/закуски —
// последними, остальное — между блюдами и баром (определяется по названию
// рубрики). Порядок блюд внутри рубрик и сами блюда не трогает — только
// порядок массива categories.
// Запуск:  npm run reorder-categories
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Не найдены VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY в .env"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Совпадает с categoryRank в src/App.jsx — держим оба места в согласии,
// если поменяешь одно, поменяй и другое.
const categoryRank = (cat) => {
  const text = `${cat.name || ""}`.toLowerCase();
  if (/снек|снэк|закуск|snack/.test(text)) return 3;
  if (/\bбар\b|напит|коктейл|вино|пиво|алкогол|bar|drink|cocktail/.test(text))
    return 2;
  if (
    /горяч|основн|\bблюда\b|кухня|\bеда\b|первое|второе|шашлык|плов|манты|main|kitchen|\bfood\b/.test(
      text
    )
  )
    return 0;
  return 1;
};

const { data: rows, error } = await supabase
  .from("restaurants")
  .select("id, name, menu");

if (error) {
  console.error("Не удалось прочитать таблицу restaurants:", error.message);
  process.exit(1);
}

let changed = 0;
let unchanged = 0;

for (const row of rows) {
  const categories = row.menu?.categories || [];
  if (categories.length < 2) {
    unchanged++;
    continue;
  }
  const sorted = [...categories]
    .map((c, idx) => ({ c, idx })) // стабильная сортировка вручную, на случай старого Node
    .sort((a, b) => categoryRank(a.c) - categoryRank(b.c) || a.idx - b.idx)
    .map((x) => x.c);

  const alreadySorted = sorted.every((c, i) => c.id === categories[i].id);
  if (alreadySorted) {
    unchanged++;
    continue;
  }

  const newMenu = { ...row.menu, categories: sorted };
  const { error: updateError } = await supabase
    .from("restaurants")
    .update({ menu: newMenu, updated_at: new Date().toISOString() })
    .eq("id", row.id);

  if (updateError) {
    console.log(`⚠️  ${row.id} (${row.name}) — ошибка: ${updateError.message}`);
    continue;
  }
  changed++;
  console.log(
    `✅ ${row.id} (${row.name}): ${categories.map((c) => c.name).join(", ")} → ${sorted
      .map((c) => c.name)
      .join(", ")}`
  );
}

console.log(`\nГотово. Переставлено: ${changed}, без изменений: ${unchanged}.`);
