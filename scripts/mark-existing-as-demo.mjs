// Разовая правка данных: помечает ВСЕ кафе, которые уже есть в базе на
// момент запуска, как демо (is_demo = true) — им больше не нужно повторно
// вводить PIN при входе как администратор и при редактировании меню (см.
// AdminMenuEditor.jsx/AdminScreen.jsx). Новые кафе, добавленные после этого,
// создаются с is_demo = false (обычная защита PIN-кодом) — см.
// OwnerDashboard.jsx/push-menu.mjs.
//
// Требует колонку is_demo в таблице restaurants — см. README.md.
// Запуск:  npm run mark-existing-as-demo
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
  console.error("Не найдены VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY в .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const { data: rows, error: fetchError } = await supabase
  .from("restaurants")
  .select("id, name, is_demo");

if (fetchError) {
  console.error("Не удалось прочитать таблицу restaurants:", fetchError.message);
  process.exit(1);
}

const toMark = rows.filter((r) => !r.is_demo);

if (toMark.length === 0) {
  console.log("Нечего помечать — все кафе уже отмечены как демо.");
  process.exit(0);
}

const { error: updateError } = await supabase
  .from("restaurants")
  .update({ is_demo: true })
  .in(
    "id",
    toMark.map((r) => r.id)
  );

if (updateError) {
  console.error("Ошибка обновления:", updateError.message);
  process.exit(1);
}

console.log(`Готово. Помечено как демо: ${toMark.length}`);
toMark.forEach((r) => console.log(`   ${r.id} — ${r.name}`));
