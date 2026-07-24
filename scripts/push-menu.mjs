// Добавление НОВЫХ кафе и обновление меню УЖЕ СУЩЕСТВУЮЩИХ — напрямую в общую
// базу данных. Никаких отдельных сборок сайтов больше нет: сайт один на всех,
// а кафе (со своим меню) определяется во время работы сайта по PIN-коду.
//
// Рабочий процесс:
//   1. Получил меню от клиента → скормил промпт (PROMPT-FOR-AI.md) в DeepSeek
//   2. Сохранил ответ как incoming/<id-кафе>.json — файл должен содержать
//      { "name": "...", "categories": [...], "items": [...] }
//        - если такого id ЕЩЁ НЕТ в базе → создаётся новое кафе и для него
//          генерируется PIN-код (скрипт выведет его — сообщи клиенту)
//        - если id УЖЕ ЕСТЬ → меню обновляется, PIN остаётся тем же самым
//   3. Запустил:  npm run push-menu
//
// Больше не нужно ничего пушить на GitHub ради нового клиента — правки
// применяются мгновенно, сайт при этом остаётся один и тот же.
import { createClient } from "@supabase/supabase-js";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { validateMenu, isValidCafeId } from "./menu-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const incomingDir = path.join(rootDir, "incoming");
const processedDir = path.join(incomingDir, "_processed");

mkdirSync(incomingDir, { recursive: true });
mkdirSync(processedDir, { recursive: true });

// Node не читает .env сам по себе (в отличие от Vite) — подхватываем те же
// переменные, что уже используются для сайта, чтобы не задавать их дважды.
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
    "Не найдены VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.\n" +
      "Задай их в файле .env в корне проекта (те же значения, что и для сайта) " +
      "или передай перед командой: SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run push-menu"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function generatePin(existingPins, length = 5) {
  let pin;
  do {
    pin = String(Math.floor(Math.random() * 10 ** length)).padStart(length, "0");
  } while (existingPins.has(pin));
  return pin;
}

const files = readdirSync(incomingDir).filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.log(
    "В incoming/ нет файлов меню.\n" +
      "Положи туда файл incoming/<id-кафе>.json (формат — см. PROMPT-FOR-AI.md) и запусти снова."
  );
  process.exit(0);
}

const { data: existingRows, error: fetchError } = await supabase
  .from("restaurants")
  .select("id, pin");

if (fetchError) {
  console.error("Не удалось прочитать таблицу restaurants:", fetchError.message);
  process.exit(1);
}

const existingIds = new Map(existingRows.map((r) => [r.id, r.pin]));
const existingPins = new Set(existingRows.map((r) => r.pin));

const added = [];
const updated = [];
const skipped = [];

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  const filePath = path.join(incomingDir, file);
  const label = `incoming/${file}`;

  if (!isValidCafeId(id)) {
    skipped.push(`${file} — имя файла должно быть латиницей/цифрами/дефисами, например "kafe-vostok.json"`);
    continue;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    skipped.push(`${file} — невалидный JSON: ${e.message}`);
    continue;
  }

  const name = raw.name;
  if (!name || typeof name !== "string") {
    skipped.push(`${file} — нет поля "name" (название кафе) или оно не строка`);
    continue;
  }

  const { errors, categories, items } = validateMenu(raw, label);
  if (errors.length > 0) {
    errors.forEach((e) => skipped.push(e));
    continue;
  }

  const menu = { categories, items };

  if (existingIds.has(id)) {
    // Кафе уже есть — обновляем меню и имя, PIN не трогаем
    const { error } = await supabase
      .from("restaurants")
      .update({ name, menu, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      skipped.push(`${file} — ошибка обновления в базе: ${error.message}`);
      continue;
    }
    updated.push({ id, name, categories: categories.length, items: items.length });
  } else {
    // Новое кафе — генерируем PIN и создаём запись, с пробным периодом 5 дней
    const pin = generatePin(existingPins);
    existingPins.add(pin);
    const trialEndsAt = new Date(
      Date.now() + 5 * 24 * 60 * 60 * 1000
    ).toISOString();
    const { error } = await supabase
      .from("restaurants")
      .insert([{ id, name, pin, status: "active", menu, trial_ends_at: trialEndsAt }]);
    if (error) {
      skipped.push(`${file} — ошибка создания в базе: ${error.message}`);
      continue;
    }
    existingIds.set(id, pin);
    added.push({ id, name, pin, categories: categories.length, items: items.length });
  }

  renameSync(filePath, path.join(processedDir, file));
}

console.log("\n=== Результат ===\n");
if (added.length > 0) {
  console.log(`✅ Новых кафе: ${added.length}`);
  added.forEach((c) =>
    console.log(
      `   ${c.id}  —  ${c.name}  (рубрик: ${c.categories}, блюд: ${c.items})\n` +
        `   🔑 PIN для этого кафе: ${c.pin}  ← сообщи официантам клиента`
    )
  );
}
if (updated.length > 0) {
  console.log(`\n🔄 Обновлено меню у существующих: ${updated.length}`);
  updated.forEach((c) =>
    console.log(`   ${c.id}  —  ${c.name}  (рубрик: ${c.categories}, блюд: ${c.items})`)
  );
}
if (skipped.length > 0) {
  console.log(`\n⚠️  Пропущено (нужно поправить и положить файл в incoming/ снова):`);
  skipped.forEach((s) => console.log(`   ${s}`));
}
if (added.length === 0 && updated.length === 0 && skipped.length === 0) {
  console.log("Нечего обрабатывать.");
}
