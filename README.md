# Меню официанта — один сайт на все кафе, вход по PIN-коду

Архитектура, рассчитанная на 100+ клиентов:

- **Сайт один.** Один код, один билд, один деплой на GitHub Pages. Меняешь
  дизайн или добавляешь функцию один раз в коде — применяется у всех
  клиентов сразу, без пересборки под каждого.
- **База данных одна общая** (Supabase). Кафе физически разделены только
  своими данными (`restaurant_id` в заказах, отдельная строка в таблице
  `restaurants`), а не отдельными базами или сайтами.
- **Меню тоже в базе**, не в файлах кода. Правишь — применяется мгновенно,
  без пересборки и передеплоя сайта.
- **Кафе определяется по PIN-коду.** Официант один раз вводит PIN, дальше он
  запоминается на этом телефоне (в localStorage) — при следующих открытиях
  сайта PIN вводить не нужно.

## Шаг 1. Создать Supabase-проект и таблицы

1. supabase.com → New project (один-единственный, на все кафе сразу)
2. SQL Editor → выполнить:

```sql
create table restaurants (
  id text primary key,
  name text not null,
  pin text not null unique,
  status text not null default 'active', -- 'active' | 'disabled'
  menu jsonb not null default '{"categories": [], "items": []}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table orders (
  id text primary key,
  restaurant_id text not null references restaurants(id) on delete cascade,
  waiter text not null,
  table_number int not null,
  items jsonb not null default '[]'::jsonb,
  items_count int not null default 0,
  total numeric not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index orders_restaurant_id_idx on orders (restaurant_id);

alter table restaurants enable row level security;
alter table orders enable row level security;

create policy "public read restaurants" on restaurants for select using (true);
create policy "public insert restaurants" on restaurants for insert with check (true);
create policy "public update restaurants" on restaurants for update using (true);
create policy "public delete restaurants" on restaurants for delete using (true);

create policy "public read orders" on orders for select using (true);
create policy "public insert orders" on orders for insert with check (true);
create policy "public update orders" on orders for update using (true);
create policy "public delete orders" on orders for delete using (true);

-- Realtime: официанты видят заказы друг друга мгновенно, без задержки опроса
alter publication supabase_realtime add table orders;

-- Пробный период и продление подписки. NULL в trial_ends_at у уже
-- существующих кафе означает "без ограничения по времени" — доступ никогда
-- не блокируется. Новые кафе (через панель владельца или push-menu)
-- получают trial_ends_at = дата создания + 5 дней автоматически.
alter table restaurants add column if not exists trial_ends_at timestamptz;
alter table restaurants add column if not exists paid_until timestamptz;

-- Демо-кафе (заведены до появления PIN-защиты входа в администратора) не
-- спрашивают PIN повторно при входе как администратор и при редактировании
-- меню — это витрины для показа функционала. Новые кафе всегда is_demo = false.
alter table restaurants add column if not exists is_demo boolean not null default false;
```

3. Project Settings → API → скопировать **Project URL** и **anon public**
   ключ.

## Шаг 2. Настроить проект локально

Создать файл `.env` в корне проекта:

```
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
VITE_OWNER_PASSWORD=придумай-свой-пароль
```

```
npm install
npm run dev
```

## Шаг 3. Добавить первое кафе

1. Меню от клиента прогоняешь через промпт из `PROMPT-FOR-AI.md`
   (например, в бесплатном DeepSeek)
2. Ответ сохраняешь как `incoming/<id-кафе>.json`
3. Выполняешь: `npm run push-menu`
4. Скрипт создаёт запись в базе и **выводит PIN-код** — например:
   ```
   ✅ Новых кафе: 1
      kafe-vostok  —  Кафе Восток  (рубрик: 2, блюд: 12)
      🔑 PIN для этого кафе: 48213  ← сообщи официантам клиента
   ```
5. Даёшь клиенту адрес сайта и этот PIN — дальше он вводит его один раз,
   телефон запомнит вход сам

## Обновление меню у существующего клиента

Точно так же: заново прогнать актуальный список через промпт, сохранить под
**тем же id** в `incoming/`, `npm run push-menu`. Меню обновится, PIN
останется прежним — клиенту ничего заново вводить не придётся.

## Добавление клиентов — по одному, по мере обращений

Ровно те же 3 шага, что и в Шаге 3 — не имеет значения, обрабатываешь ли ты
так одного клиента в день или сразу пачку файлов в `incoming/` за раз.
Никаких git push и ожидания сборки ради нового клиента — правки в базе
применяются мгновенно.

## Изменение дизайна / добавление функции для ВСЕХ клиентов разом

Именно в этом главное преимущество этой архитектуры перед "сайт на каждое
кафе": правишь `src/App.jsx` (или что угодно ещё в коде) один раз, делаешь
`git push` — GitHub Actions пересобирает **один-единственный** сайт и
выкладывает его. Все 100+ клиентов в ту же секунду видят новый дизайн или
новую функцию, потому что физически заходят на один и тот же сайт — просто
после ввода PIN подгружают каждый своё содержимое.

## Деплой на GitHub Pages

1. Создать репозиторий на GitHub, залить туда содержимое этой папки
2. Settings → Secrets and variables → Actions → добавить 3 секрета:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_OWNER_PASSWORD`
3. Settings → Pages → Source → **GitHub Actions**
4. Запушить в `main` (или запустить workflow вручную) — через минуту сайт
   опубликован по адресу `https://<username>.github.io/<repo>/`

## Панель владельца

Живёт на том же сайте, по адресу с `#owner` в конце —
`https://<username>.github.io/<repo>/#owner`. Официантам эта ссылка не
нужна и никак не показывается в обычном интерфейсе.

Что можно:
- увидеть список всех кафе (поиск по названию/id, PIN с копированием)
- добавить новое кафе (PIN генерируется автоматически)
- отредактировать меню — вставкой JSON целиком (дополняет существующее меню,
  не стирает) или построчно (добавить/убрать рубрику или блюдо)
- отключить кафе (официанты этого заведения сразу перестанут заходить по
  PIN, увидят сообщение, что кафе временно отключено) или включить обратно
- удалить кафе целиком (вместе с его заказами — настроено каскадное удаление)

Вход защищён паролем (`VITE_OWNER_PASSWORD`) — см. предупреждение в разделе
про безопасность ниже.

## Как это устроено технически

- `src/restaurant.js` — вся логика входа официанта: чтение/запись id кафе в
  `localStorage`, поиск кафе по PIN (`fetchRestaurantByPin`) и по
  сохранённому id (`fetchRestaurantById`, вызывается при каждом открытии
  сайта — так меню всегда свежее, даже если его недавно поменяли, а
  отключённое кафе сразу блокирует вход).
- `src/App.jsx` — экран PIN (`PinScreen`) → выбор официанта → сам экран
  заказа. Категории и блюда приходят как данные (props), а не зашиты в код.
- `src/OwnerDashboard.jsx` + `src/OwnerGate.jsx` + `src/ownerAuth.js` —
  панель владельца и её защита паролем.
- `scripts/push-menu.mjs` — читает файлы из `incoming/`, проверяет формат
  (`scripts/menu-utils.mjs` — тот же модуль валидации переиспользует и
  панель владельца в браузере), создаёт новые кафе с случайным уникальным
  PIN-кодом или обновляет меню существующих напрямую в Supabase.

## Про безопасность

PIN — это единственный "ключ" к данным кафе, поэтому:
- Используй PIN длиной от 5 цифр (скрипт генерирует именно такие) — так его
  сложнее подобрать случайно.
- Не публикуй PIN нигде, кроме как лично клиенту.
- Как и раньше: разделение обеспечивается фильтрацией в коде и запросах, а
  не строгими политиками базы (RLS сейчас разрешает читать/писать всем, у
  кого есть анонимный ключ проекта — то есть теоретически, зная и ключ
  проекта, и точный PIN, чужие данные технически достать можно). Для 100
  доверенных клиентов на пилоте это приемлемый уровень риска. Если понадобится
  строже — можно добавить Supabase Auth и настоящие RLS-политики по
  авторизованному пользователю, а не по PIN в теле запроса. Дай знать, если
  захочешь сделать это заранее.

**Про пароль панели владельца — важно понимать честно:** экран пароля
(`VITE_OWNER_PASSWORD`) защищает только от случайного захода не по адресу.
Он НЕ является настоящей авторизацией — и пароль, и anon-ключ Supabase всё
равно лежат в собранном JS-файле сайта, а текущие RLS-политики разрешают
любому, у кого есть этот ключ, читать и менять таблицу `restaurants` в обход
интерфейса сайта. Это та же модель риска, что и с PIN у кафе, только для
данных ВСЕХ кафе разом — так что для панели владельца эта осторожность ещё
важнее. Если планируешь доверить эту панель кому-то ещё, кроме себя, или
данные станут по-настоящему ценными — стоит заранее перейти на Supabase Auth.

## Лимиты

- Supabase free: 500 МБ базы — для сотен кафе с обычным потоком заказов
  запас большой.
- GitHub Pages free: 100 ГБ трафика/месяц — сайт один и лёгкий, более чем
  достаточно.
- GitHub Actions: неограниченные минуты для публичного репозитория, а
  сборка теперь ещё и одна на весь сайт, а не по одной на кафе — быстрее,
  чем в предыдущей схеме.
- Домен один на всех: все кафе заходят на один и тот же адрес и вводят свой
  PIN. Если кому-то из клиентов понадобится свой собственный домен — можно
  будет сделать редирект на этот сайт с предзаполненным PIN, дай знать,
  когда понадобится.
