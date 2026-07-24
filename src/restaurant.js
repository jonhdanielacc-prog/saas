import { supabase } from "./supabaseClient";

// Кафе, к которому привязано ЭТО устройство, хранится в localStorage — чтобы
// официант вводил PIN один раз, а не при каждом открытии сайта.
const CACHE_KEY = "waiter-menu-cafe-id";

export function getCachedRestaurantId() {
  try {
    return localStorage.getItem(CACHE_KEY);
  } catch (e) {
    return null;
  }
}

export function setCachedRestaurantId(id) {
  try {
    if (id) localStorage.setItem(CACHE_KEY, id);
    else localStorage.removeItem(CACHE_KEY);
  } catch (e) {
    // приватный режим браузера и т.п. — не критично, просто будут чаще спрашивать PIN
  }
}

const DISABLED_MESSAGE =
  "Это кафе временно отключено. Обратитесь к владельцу сервиса.";

const TRIAL_EXPIRED_MESSAGE =
  "Пробный период закончился. Обратитесь к владельцу сервиса, чтобы продлить доступ.";

const DAY_MS = 24 * 60 * 60 * 1000;

// Статус пробного периода/подписки кафе — используется и чтобы заблокировать
// вход после его окончания, и чтобы показать баннер с обратным отсчётом, пока
// он ещё идёт. Кафе без trial_ends_at (заведено до появления этой функции,
// либо владелец решил не включать для него пробный период) — доступ никогда
// не ограничивается, баннер не показывается.
export function getAccessStatus(restaurant, nowMs = Date.now()) {
  const trialEndsAtRaw = restaurant?.trial_ends_at;
  if (!trialEndsAtRaw) return { blocked: false };

  const trialEndsAt = new Date(trialEndsAtRaw).getTime();
  const paidUntilRaw = restaurant?.paid_until;
  const paidUntil = paidUntilRaw ? new Date(paidUntilRaw).getTime() : null;

  if (nowMs < trialEndsAt) {
    const daysLeft = Math.max(1, Math.ceil((trialEndsAt - nowMs) / DAY_MS));
    return { blocked: false, inTrial: true, daysLeft, endingSoon: daysLeft <= 1 };
  }

  if (paidUntil !== null && nowMs < paidUntil) {
    return { blocked: false, inTrial: false, paidUntil: paidUntilRaw };
  }

  return { blocked: true, message: TRIAL_EXPIRED_MESSAGE };
}

const RESTAURANT_FIELDS = "id, name, menu, status, pin, trial_ends_at, paid_until";

// Достаёт кафе и его меню по PIN-коду (вводит официант при первом входе).
// PIN сравнивается без учёта регистра — официанту не нужно следить за
// заглавными буквами при наборе.
export async function fetchRestaurantByPin(pin) {
  if (!supabase) return { error: "Сайт не настроен (нет подключения к базе)." };
  const { data, error } = await supabase
    .from("restaurants")
    .select(RESTAURANT_FIELDS)
    .eq("pin", pin.trim().toUpperCase())
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "Неверный PIN-код. Проверьте и попробуйте снова." };
  if (data.status === "disabled") return { error: DISABLED_MESSAGE };
  const access = getAccessStatus(data);
  if (access.blocked) return { error: access.message };
  return { restaurant: data };
}

// Достаёт кафе и его АКТУАЛЬНОЕ меню по сохранённому id (обычный вход,
// когда PIN уже вводили раньше на этом устройстве). Меню всегда берётся
// свежее из базы — так его можно обновлять без переустановки сайта, а если
// владелец отключил кафе — вход тоже сразу заблокируется.
export async function fetchRestaurantById(id) {
  if (!supabase) return { error: "Сайт не настроен (нет подключения к базе)." };
  const { data, error } = await supabase
    .from("restaurants")
    .select(RESTAURANT_FIELDS)
    .eq("id", id)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "Это кафе больше не найдено в базе." };
  if (data.status === "disabled") return { error: DISABLED_MESSAGE };
  const access = getAccessStatus(data);
  if (access.blocked) return { error: access.message };
  return { restaurant: data };
}
