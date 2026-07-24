import React, { useState, useEffect, useMemo } from "react";
import {
  Plus,
  Trash2,
  Search,
  X,
  Check,
  Power,
  PowerOff,
  Pencil,
  Copy,
  Link as LinkIcon,
  RefreshCw,
  Upload,
  Store,
  LogOut,
  RefreshCcw,
  CalendarPlus,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { validateMenu, isValidCafeId } from "../scripts/menu-utils.mjs";
import { lockOwner } from "./ownerAuth";
import { ICON_OPTIONS, iconByKey } from "./menuIcons";
import { getAccessStatus } from "./restaurant";

const money = (n) => (n || 0).toLocaleString("ru-RU");

const TRIAL_DAYS = 5;
const EXTEND_DAYS = 30;

function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

// Короткое описание статуса пробного периода/подписки для строки кафе в панели.
function accessLabel(restaurant) {
  const access = getAccessStatus(restaurant);
  if (!restaurant.trial_ends_at) return null; // трекинг пробного периода не включен
  if (access.blocked) return { text: "Пробный период истёк", tone: "danger" };
  if (access.inTrial) {
    return {
      text: access.endingSoon
        ? "Пробный период: последний день"
        : `Пробный период: ${access.daysLeft} ${pluralDays(access.daysLeft)}`,
      tone: access.endingSoon ? "danger" : "warn",
    };
  }
  if (access.paidUntil) {
    return {
      text: `Оплачено до ${new Date(access.paidUntil).toLocaleDateString("ru-RU")}`,
      tone: "ok",
    };
  }
  return null;
}

// 5 символов, буквы + цифры (без похожих друг на друга O/0, I/1/L) — сложнее
// подобрать случайно, чем старый 5-значный числовой PIN, и всё ещё легко
// продиктовать/переписать официанту.
const PIN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generatePin = (existing) => {
  let pin;
  do {
    pin = Array.from({ length: 5 }, () => PIN_CHARS[Math.floor(Math.random() * PIN_CHARS.length)]).join("");
  } while (existing.includes(pin));
  return pin;
};

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё\s-]/gi, "")
    .replace(/[а-яё]/g, (ch) => {
      const map = {
        а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
        з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
        п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
        ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
      };
      return map[ch] ?? "";
    })
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || `kafe-${Date.now().toString().slice(-5)}`;

// Ссылка для конкретного кафе — офиициант переходит по ней и сразу входит,
// не набирая PIN руками (PIN всё равно подставляется автоматически по нему же).
const cafeLink = (pin) => `${window.location.origin}${window.location.pathname}?pin=${pin}`;

export default function OwnerDashboard({ onLock }) {
  const [restaurants, setRestaurants] = useState(null); // null = ещё грузится
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null); // объект кафе или "new"
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [copiedLinkId, setCopiedLinkId] = useState(null);

  const copyLink = (r) => {
    navigator.clipboard?.writeText(cafeLink(r.pin));
    setCopiedLinkId(r.id);
    setTimeout(() => setCopiedLinkId((cur) => (cur === r.id ? null : cur)), 1500);
  };

  const loadAll = async () => {
    const { data, error } = await supabase
      .from("restaurants")
      .select("id, name, pin, status, menu, created_at, trial_ends_at, paid_until")
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setRestaurants(data);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    if (!restaurants) return [];
    const q = search.trim().toLowerCase();
    if (!q) return restaurants;
    return restaurants.filter(
      (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
    );
  }, [restaurants, search]);

  const stats = useMemo(() => {
    if (!restaurants) return { total: 0, active: 0, disabled: 0, items: 0 };
    return {
      total: restaurants.length,
      active: restaurants.filter((r) => r.status === "active").length,
      disabled: restaurants.filter((r) => r.status === "disabled").length,
      items: restaurants.reduce((s, r) => s + (r.menu?.items?.length || 0), 0),
    };
  }, [restaurants]);

  const toggleStatus = async (id) => {
    const target = restaurants.find((r) => r.id === id);
    const nextStatus = target.status === "active" ? "disabled" : "active";
    // Оптимистично обновляем интерфейс сразу, не дожидаясь ответа базы
    setRestaurants((prev) => prev.map((r) => (r.id === id ? { ...r, status: nextStatus } : r)));
    const { error } = await supabase
      .from("restaurants")
      .update({ status: nextStatus })
      .eq("id", id);
    if (error) {
      setLoadError(error.message);
      loadAll(); // откатываем интерфейс к тому, что реально в базе
    }
  };

  // Продлить на месяц — от текущей даты окончания оплаты, если она еще не
  // прошла (продление "про запас"), иначе от сегодня. Работает и в пробном
  // периоде (продлевает заранее), и после его окончания.
  const extendSubscription = async (id) => {
    const target = restaurants.find((r) => r.id === id);
    const now = Date.now();
    const currentPaidUntil = target.paid_until
      ? new Date(target.paid_until).getTime()
      : 0;
    const base = currentPaidUntil > now ? currentPaidUntil : now;
    const nextPaidUntil = new Date(
      base + EXTEND_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    setRestaurants((prev) =>
      prev.map((r) => (r.id === id ? { ...r, paid_until: nextPaidUntil } : r))
    );
    const { error } = await supabase
      .from("restaurants")
      .update({ paid_until: nextPaidUntil })
      .eq("id", id);
    if (error) {
      setLoadError(error.message);
      loadAll();
    }
  };

  const deleteCafe = async (id) => {
    setConfirmDelete(null);
    setRestaurants((prev) => prev.filter((r) => r.id !== id));
    const { error } = await supabase.from("restaurants").delete().eq("id", id);
    if (error) {
      setLoadError(error.message);
      loadAll();
    }
  };

  const openNew = () => {
    const existingPins = restaurants.map((r) => r.pin);
    setEditing({
      id: null,
      name: "",
      pin: generatePin(existingPins),
      status: "active",
      isNew: true,
      menu: { categories: [], items: [] },
    });
    setSaveError(null);
  };

  const saveCafe = async (cafe) => {
    if (!cafe.name.trim()) {
      setSaveError("Впишите название кафе.");
      return;
    }
    if (!cafe.menu.categories.length) {
      setSaveError("Добавьте хотя бы одну рубрику.");
      return;
    }
    if (!cafe.menu.items.length) {
      setSaveError("Добавьте хотя бы одно блюдо.");
      return;
    }

    if (cafe.isNew) {
      const id = slugify(cafe.name);
      const finalId = restaurants.some((r) => r.id === id)
        ? `${id}-${Date.now().toString().slice(-4)}`
        : id;
      const { error } = await supabase.from("restaurants").insert([
        {
          id: finalId,
          name: cafe.name.trim(),
          pin: cafe.pin,
          status: "active",
          menu: cafe.menu,
          trial_ends_at: new Date(
            Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000
          ).toISOString(),
        },
      ]);
      if (error) {
        setSaveError(error.message);
        return;
      }
    } else {
      const { error } = await supabase
        .from("restaurants")
        .update({
          name: cafe.name.trim(),
          menu: cafe.menu,
          updated_at: new Date().toISOString(),
        })
        .eq("id", cafe.id);
      if (error) {
        setSaveError(error.message);
        return;
      }
    }
    setEditing(null);
    await loadAll();
  };

  if (restaurants === null) {
    return (
      <div className="app-shell" style={styles.app}>
        <div style={styles.loadingBox}>Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="app-shell" style={styles.app}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.brand}>
            <Store size={18} strokeWidth={2.2} />
            Панель управления
          </div>
          <div style={styles.headerBtns}>
            <button style={styles.iconOnlyBtn} onClick={loadAll} aria-label="Обновить">
              <RefreshCcw size={16} strokeWidth={2.2} />
            </button>
            <button style={styles.addBtn} onClick={openNew}>
              <Plus size={16} strokeWidth={2.4} />
              Добавить кафе
            </button>
            {onLock && (
              <button style={styles.iconOnlyBtn} onClick={onLock} aria-label="Выйти">
                <LogOut size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        {loadError && (
          <div style={styles.loadErrorBanner}>
            Ошибка связи с базой: {loadError}
          </div>
        )}

        <div style={styles.statCards}>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{stats.total}</div>
            <div style={styles.statLabel}>всего кафе</div>
          </div>
          <div style={styles.statCard}>
            <div style={{ ...styles.statValue, color: "#7fbf8f" }}>{stats.active}</div>
            <div style={styles.statLabel}>активных</div>
          </div>
          <div style={styles.statCard}>
            <div style={{ ...styles.statValue, color: "#e07a72" }}>{stats.disabled}</div>
            <div style={styles.statLabel}>отключено</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{stats.items}</div>
            <div style={styles.statLabel}>блюд всего</div>
          </div>
        </div>

        <div style={styles.searchRow}>
          <Search size={15} strokeWidth={2.2} color="#8a8480" />
          <input
            style={styles.searchInput}
            placeholder="Поиск кафе по названию или id..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div style={styles.body}>
        {filtered.length === 0 ? (
          <p style={styles.empty}>Ничего не найдено.</p>
        ) : (
          filtered.map((r) => (
            <div key={r.id} style={styles.cafeRow}>
              <div style={styles.cafeRowTop}>
                <div>
                  <div style={styles.cafeName}>
                    {r.name}
                    <span
                      style={{
                        ...styles.statusBadge,
                        ...(r.status === "active" ? styles.statusActive : styles.statusDisabled),
                      }}
                    >
                      {r.status === "active" ? "Активно" : "Отключено"}
                    </span>
                  </div>
                  <div style={styles.cafeMeta}>
                    id: {r.id} · {r.menu.categories.length} рубрик · {r.menu.items.length} блюд
                  </div>
                  {accessLabel(r) && (
                    <div
                      style={{
                        ...styles.trialLabel,
                        ...(accessLabel(r).tone === "danger"
                          ? styles.trialLabelDanger
                          : accessLabel(r).tone === "ok"
                          ? styles.trialLabelOk
                          : styles.trialLabelWarn),
                      }}
                    >
                      {accessLabel(r).text}
                    </div>
                  )}
                </div>
                <div style={styles.pinBox}>
                  <span style={styles.pinLabel}>PIN</span>
                  <span style={styles.pinValue}>{r.pin}</span>
                  <button
                    style={styles.iconBtn}
                    onClick={() => navigator.clipboard?.writeText(r.pin)}
                    aria-label="Скопировать PIN"
                  >
                    <Copy size={14} strokeWidth={2.2} />
                  </button>
                </div>
              </div>
              <div style={styles.cafeActions}>
                <button
                  style={styles.actionMain}
                  onClick={() => {
                    setEditing({ ...r, isNew: false });
                    setSaveError(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={2.2} />
                  Меню
                </button>
                <button style={styles.actionIcon} onClick={() => copyLink(r)} aria-label="Ссылка для входа">
                  {copiedLinkId === r.id ? <Check size={15} strokeWidth={2.2} /> : <LinkIcon size={15} strokeWidth={2.2} />}
                </button>
                {r.trial_ends_at && (
                  <button
                    style={styles.actionIcon}
                    onClick={() => extendSubscription(r.id)}
                    aria-label="Продлить подписку на 1 месяц"
                    title="Продлить на 1 месяц"
                  >
                    <CalendarPlus size={15} strokeWidth={2.2} />
                  </button>
                )}
                <button
                  style={{ ...styles.actionIcon, ...(r.status === "active" ? {} : { borderColor: "#7fbf8f", color: "#7fbf8f" }) }}
                  onClick={() => toggleStatus(r.id)}
                  aria-label={r.status === "active" ? "Отключить" : "Включить"}
                >
                  {r.status === "active" ? <PowerOff size={15} strokeWidth={2.2} /> : <Power size={15} strokeWidth={2.2} />}
                </button>
                <button
                  style={{ ...styles.actionIcon, color: "#e07a72" }}
                  onClick={() => setConfirmDelete(r)}
                  aria-label="Удалить"
                >
                  <Trash2 size={15} strokeWidth={2.2} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <CafeEditor
          cafe={editing}
          error={saveError}
          existingPins={restaurants.map((r) => r.pin)}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={saveCafe}
        />
      )}

      {confirmDelete && (
        <div style={{ ...styles.overlay, alignItems: "center" }} onClick={() => setConfirmDelete(null)}>
          <div style={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.confirmIcon}>
              <Trash2 size={22} strokeWidth={2.2} />
            </div>
            <div style={styles.confirmTitle}>Удалить «{confirmDelete.name}»?</div>
            <div style={styles.confirmText}>
              Кафе и его меню будут удалены безвозвратно. Официанты этого заведения
              больше не смогут войти по своему PIN.
            </div>
            <div style={styles.confirmActions}>
              <button style={styles.confirmCancelBtn} onClick={() => setConfirmDelete(null)}>
                Оставить
              </button>
              <button style={styles.confirmDeleteBtn} onClick={() => deleteCafe(confirmDelete.id)}>
                Да, удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Редактор кафе (добавление / правка меню) ------------------------------

function CafeEditor({ cafe, error, existingPins = [], onChange, onCancel, onSave }) {
  const [showImport, setShowImport] = useState(true);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState(null);

  const set = (patch) => onChange({ ...cafe, ...patch });
  const setMenu = (patch) => onChange({ ...cafe, menu: { ...cafe.menu, ...patch } });

  const addCategory = () => {
    const id = `cat${cafe.menu.categories.length + 1}`;
    setMenu({ categories: [...cafe.menu.categories, { id, name: "", icon: "package" }] });
  };
  const updateCategory = (idx, patch) => {
    const next = [...cafe.menu.categories];
    next[idx] = { ...next[idx], ...patch };
    setMenu({ categories: next });
  };
  const removeCategory = (idx) => {
    const removedId = cafe.menu.categories[idx].id;
    setMenu({
      categories: cafe.menu.categories.filter((_, i) => i !== idx),
      items: cafe.menu.items.filter((it) => it.category !== removedId),
    });
  };

  const addItem = () => {
    const id = `item${Date.now().toString().slice(-6)}`;
    const firstCat = cafe.menu.categories[0]?.id || "";
    setMenu({ items: [...cafe.menu.items, { id, name: "", price: 0, category: firstCat }] });
  };
  const updateItem = (idx, patch) => {
    const next = [...cafe.menu.items];
    next[idx] = { ...next[idx], ...patch };
    setMenu({ items: next });
  };
  const removeItem = (idx) => {
    setMenu({ items: cafe.menu.items.filter((_, i) => i !== idx) });
  };

  const [importInfo, setImportInfo] = useState(null);

  const applyImport = () => {
    let raw;
    try {
      raw = JSON.parse(importText);
    } catch (e) {
      setImportError(`Невалидный JSON: ${e.message}`);
      setImportInfo(null);
      return;
    }
    const { errors, categories, items } = validateMenu(raw, "Импорт");
    if (errors.length > 0) {
      setImportError(errors[0]);
      setImportInfo(null);
      return;
    }

    // Рубрики: добавляем только те, которых ещё нет — существующие не трогаем
    const existingCatIds = new Set(cafe.menu.categories.map((c) => c.id));
    const newCats = categories.filter((c) => !existingCatIds.has(c.id));
    const mergedCategories = [...cafe.menu.categories, ...newCats];

    // Блюда: новые id — добавляются, совпадающие id — обновляются (цена/название/рубрика)
    const itemMap = new Map(cafe.menu.items.map((it) => [it.id, it]));
    let addedCount = 0;
    let updatedCount = 0;
    items.forEach((it) => {
      if (itemMap.has(it.id)) updatedCount += 1;
      else addedCount += 1;
      itemMap.set(it.id, it);
    });
    const mergedItems = [...itemMap.values()];

    setMenu({ categories: mergedCategories, items: mergedItems });
    if (raw.name && cafe.isNew && !cafe.name.trim()) set({ name: raw.name });
    setImportError(null);
    setImportInfo(
      `Готово: добавлено рубрик — ${newCats.length}, добавлено блюд — ${addedCount}, обновлено блюд — ${updatedCount}.`
    );
    setImportText("");
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.editorModal}>
        <div style={styles.editorHeader}>
          <div style={styles.editorTitle}>
            {cafe.isNew ? "Новое кафе" : `Редактирование: ${cafe.name}`}
          </div>
          <button style={styles.iconBtn} onClick={onCancel}>
            <X size={20} />
          </button>
        </div>

        <div style={styles.editorBody}>
          <label style={styles.fieldLabel}>Название кафе</label>
          <input
            style={styles.fieldInput}
            value={cafe.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Например: Кафе Восток"
          />

          {cafe.isNew && (
            <>
              <label style={styles.fieldLabel}>PIN-код (сгенерирован автоматически)</label>
              <div style={styles.pinRow}>
                <input style={styles.fieldInput} value={cafe.pin} readOnly />
                <button
                  style={styles.iconBtnBordered}
                  onClick={() => set({ pin: generatePin(existingPins) })}
                  aria-label="Перегенерировать PIN"
                >
                  <RefreshCw size={15} strokeWidth={2.2} />
                </button>
              </div>
            </>
          )}

          <button style={styles.importToggle} onClick={() => setShowImport((s) => !s)}>
            <Upload size={14} strokeWidth={2.2} />
            {showImport ? "Скрыть вставку кода" : "Вставить сразу много блюд кодом (JSON от DeepSeek)"}
          </button>
          {showImport && (
            <div style={styles.importBox}>
              <p style={styles.importHint}>
                Вставьте JSON целиком — новые блюда и рубрики добавятся к тем,
                что уже есть ниже, а совпадающие по id — обновятся. Уже
                введённое вручную никуда не пропадёт.
              </p>
              <textarea
                style={styles.importTextarea}
                placeholder='{"name": "...", "categories": [...], "items": [...]}'
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setImportInfo(null);
                }}
                rows={5}
              />
              {importError && <div style={styles.importError}>{importError}</div>}
              {importInfo && <div style={styles.importSuccess}>{importInfo}</div>}
              <button style={styles.applyImportBtn} onClick={applyImport}>
                Добавить эти блюда к меню
              </button>
            </div>
          )}

          <div style={styles.sectionTitle}>Рубрики меню</div>
          <p style={styles.sectionHint}>
            Рубрика — это раздел меню, между которыми официант переключается
            вкладками наверху, например «Кухня», «Напитки», «Бар», «Десерты».
            Сначала заведите нужные рубрики здесь, а потом у каждого блюда
            ниже укажете, в какую рубрику оно попадает. Можно и так, и кодом
            выше одновременно — не затрёт то, что уже есть.
          </p>
          {cafe.menu.categories.map((cat, idx) => {
            const Icon = iconByKey(cat.icon);
            return (
              <div key={idx} style={styles.catRow}>
                <div style={styles.catRowTop}>
                  <input
                    style={styles.catNameInput}
                    value={cat.name}
                    placeholder="Например: Кухня"
                    onChange={(e) => updateCategory(idx, { name: e.target.value })}
                  />
                  <button style={styles.rowDeleteBtn} onClick={() => removeCategory(idx)} aria-label="Удалить рубрику">
                    <Trash2 size={14} strokeWidth={2.2} />
                  </button>
                </div>
                <div style={styles.iconPickerLabel}>Иконка рубрики</div>
                <div style={styles.iconPickerGrid}>
                  {ICON_OPTIONS.map((o) => (
                    <button
                      key={o.key}
                      style={{ ...styles.iconPickerBtn, ...(cat.icon === o.key ? styles.iconPickerBtnActive : {}) }}
                      onClick={() => updateCategory(idx, { icon: o.key })}
                      aria-label={o.label}
                      title={o.label}
                    >
                      <o.Icon size={17} strokeWidth={2.1} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <button style={styles.addRowBtn} onClick={addCategory}>
            <Plus size={14} strokeWidth={2.2} />
            Добавить рубрику
          </button>

          <div style={styles.sectionTitle}>Блюда</div>
          {cafe.menu.items.map((item, idx) => (
            <div key={idx} style={styles.itemRow}>
              <input
                style={styles.itemNameInput}
                value={item.name}
                placeholder="Название"
                onChange={(e) => updateItem(idx, { name: e.target.value })}
              />
              <input
                style={styles.itemPriceInput}
                type="text"
                inputMode="decimal"
                value={item.price}
                onChange={(e) => updateItem(idx, { price: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })}
              />
              <select
                style={styles.itemCatSelect}
                value={item.category}
                onChange={(e) => updateItem(idx, { category: e.target.value })}
              >
                {cafe.menu.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.id}
                  </option>
                ))}
              </select>
              <button style={styles.rowDeleteBtn} onClick={() => removeItem(idx)}>
                <Trash2 size={14} strokeWidth={2.2} />
              </button>
            </div>
          ))}
          <button style={styles.addRowBtn} onClick={addItem} disabled={!cafe.menu.categories.length}>
            <Plus size={14} strokeWidth={2.2} />
            Добавить блюдо
          </button>

          {error && <div style={styles.saveError}>{error}</div>}
        </div>

        <div style={styles.editorFooter}>
          <button style={styles.cancelBtn} onClick={onCancel}>
            Отмена
          </button>
          <button style={styles.saveBtn} onClick={() => onSave(cafe)}>
            <Check size={16} strokeWidth={2.4} />
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Стили -----------------------------------------------------------------

const WINE = "#8C2F2A";
const GOLD = "#C9982E";
const INK = "#1B1918";
const PANEL = "#242120";
const PAPER = "#F4EFE6";

const styles = {
  app: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: INK,
    color: PAPER,
    maxWidth: 480,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
    padding: "18px 16px",
    borderBottom: "1px solid #35312e",
    position: "sticky",
    top: 0,
    background: INK,
    zIndex: 5,
  },
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 16,
    fontWeight: 700,
    color: PAPER,
  },
  headerBtns: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  iconOnlyBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    background: "transparent",
    border: "1px solid #3a3532",
    borderRadius: 8,
    color: "#c9c4bf",
    cursor: "pointer",
  },
  loadErrorBanner: {
    background: "rgba(179,86,79,0.14)",
    border: "1px solid #b3564f",
    color: "#e07a72",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12.5,
    marginBottom: 12,
  },
  loadingBox: {
    padding: "40px 20px",
    textAlign: "center",
    color: "#8a8480",
    fontSize: 14,
  },
  addBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: WINE,
    color: PAPER,
    border: "none",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  statCards: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 8,
    marginBottom: 14,
  },
  statCard: {
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "10px 6px",
    textAlign: "center",
  },
  statValue: { fontSize: 17, fontWeight: 700, color: GOLD },
  statLabel: { fontSize: 9.5, color: "#9a938d", marginTop: 2, lineHeight: 1.2 },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "9px 12px",
  },
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: PAPER,
    fontSize: 14,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    padding: "14px 16px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  empty: { color: "#8a8480", fontSize: 14, textAlign: "center", padding: "30px 0" },
  cafeRow: {
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 12,
    padding: "12px 14px",
  },
  cafeRowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
    gap: 10,
  },
  cafeName: {
    fontSize: 15,
    fontWeight: 700,
    color: PAPER,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 7px",
    borderRadius: 20,
  },
  statusActive: { background: "rgba(127,191,143,0.15)", color: "#7fbf8f" },
  statusDisabled: { background: "rgba(224,122,114,0.15)", color: "#e07a72" },
  cafeMeta: { fontSize: 12, color: "#8a8480", marginTop: 4 },
  trialLabel: { fontSize: 11.5, fontWeight: 600, marginTop: 5 },
  trialLabelWarn: { color: GOLD },
  trialLabelDanger: { color: "#e07a72" },
  trialLabelOk: { color: "#7fbf8f" },
  pinBox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 8,
    padding: "5px 8px",
    flexShrink: 0,
  },
  pinLabel: { fontSize: 9, color: "#6f6a65", fontWeight: 700 },
  pinValue: { fontSize: 14, color: GOLD, fontWeight: 700, letterSpacing: "0.05em" },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#8a8480",
    cursor: "pointer",
    display: "flex",
    padding: 2,
  },
  cafeActions: { display: "flex", gap: 7 },
  actionMain: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    background: "transparent",
    border: "1px solid #3a3532",
    borderRadius: 8,
    padding: "9px 0",
    fontSize: 12,
    color: "#c9c4bf",
    cursor: "pointer",
  },
  actionIcon: {
    width: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid #3a3532",
    borderRadius: 8,
    color: "#c9c4bf",
    cursor: "pointer",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 20,
  },
  editorModal: {
    width: "100%",
    maxWidth: 480,
    background: PANEL,
    borderRadius: "18px 18px 0 0",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
  },
  editorHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 18px",
    borderBottom: "1px solid #3a3532",
  },
  editorTitle: { fontSize: 16, fontWeight: 700, color: PAPER },
  editorBody: { padding: "14px 18px", overflowY: "auto", flex: 1 },
  fieldLabel: { display: "block", fontSize: 12, color: "#9a938d", marginBottom: 6, marginTop: 10 },
  fieldInput: {
    width: "100%",
    boxSizing: "border-box",
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 8,
    padding: "10px 12px",
    color: PAPER,
    fontSize: 14,
  },
  pinRow: { display: "flex", gap: 8 },
  iconBtnBordered: {
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 8,
    color: "#c9c4bf",
    cursor: "pointer",
    padding: "0 12px",
    display: "flex",
    alignItems: "center",
  },
  importToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "none",
    border: "1px dashed #3a3532",
    borderRadius: 8,
    padding: "9px 10px",
    color: "#9a938d",
    fontSize: 12.5,
    cursor: "pointer",
    marginTop: 16,
    width: "100%",
  },
  importBox: { marginTop: 10 },
  importTextarea: {
    width: "100%",
    boxSizing: "border-box",
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 8,
    padding: "10px 12px",
    color: PAPER,
    fontSize: 12.5,
    fontFamily: "monospace",
    resize: "vertical",
  },
  importHint: {
    fontSize: 12,
    color: "#9a938d",
    lineHeight: 1.4,
    margin: "0 0 8px",
  },
  importError: { color: "#e07a72", fontSize: 12, marginTop: 6 },
  importSuccess: { color: "#7fbf8f", fontSize: 12, marginTop: 6 },
  sectionHint: {
    fontSize: 11.5,
    color: "#6f6a65",
    margin: "-4px 0 10px",
    lineHeight: 1.3,
  },
  applyImportBtn: {
    marginTop: 8,
    width: "100%",
    background: GOLD,
    color: INK,
    border: "none",
    borderRadius: 8,
    padding: "9px 0",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: PAPER, margin: "18px 0 8px" },
  catRow: { display: "flex", flexDirection: "column", gap: 8, background: "#1B1918", border: "1px solid #3a3532", borderRadius: 10, padding: 10, marginBottom: 8 },
  catRowTop: { display: "flex", alignItems: "center", gap: 6 },
  iconPickerLabel: { fontSize: 10.5, color: "#6f6a65" },
  iconPickerGrid: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 },
  iconPickerBtn: { aspectRatio: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 9, border: "1px solid #3a3532", background: "transparent", color: "#c9c4bf", cursor: "pointer" },
  iconPickerBtnActive: { background: WINE, borderColor: WINE, color: PAPER },
  catNameInput: {
    flex: 1,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    padding: "7px 9px",
    color: PAPER,
    fontSize: 13,
  },
  catIconSelect: {
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    padding: "7px 6px",
    color: "#c9c4bf",
    fontSize: 12,
    maxWidth: 92,
  },
  itemRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  itemNameInput: {
    flex: 1,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    padding: "7px 9px",
    color: PAPER,
    fontSize: 13,
    minWidth: 0,
  },
  itemPriceInput: {
    width: 64,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    padding: "7px 6px",
    color: PAPER,
    fontSize: 13,
  },
  itemCatSelect: {
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    padding: "7px 4px",
    color: "#c9c4bf",
    fontSize: 11.5,
    maxWidth: 84,
  },
  rowDeleteBtn: {
    background: "none",
    border: "none",
    color: "#8a8480",
    cursor: "pointer",
    flexShrink: 0,
    display: "flex",
  },
  addRowBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "none",
    border: "1px dashed #3a3532",
    borderRadius: 8,
    padding: "8px 0",
    width: "100%",
    justifyContent: "center",
    color: "#9a938d",
    fontSize: 12.5,
    cursor: "pointer",
  },
  saveError: {
    marginTop: 14,
    color: "#e07a72",
    fontSize: 13,
    background: "rgba(224,122,114,0.1)",
    border: "1px solid #b3564f",
    borderRadius: 8,
    padding: "8px 10px",
  },
  editorFooter: {
    display: "flex",
    gap: 10,
    padding: "14px 18px",
    borderTop: "1px solid #3a3532",
  },
  cancelBtn: {
    flex: 1,
    padding: "12px 0",
    borderRadius: 10,
    border: "1px solid #3a3532",
    background: "transparent",
    color: PAPER,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  saveBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    padding: "12px 0",
    borderRadius: 10,
    border: "none",
    background: WINE,
    color: PAPER,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  confirmModal: {
    width: "100%",
    maxWidth: 380,
    background: PANEL,
    borderRadius: 18,
    padding: "26px 22px 22px",
    margin: "0 16px",
    textAlign: "center",
  },
  confirmIcon: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "rgba(179,86,79,0.15)",
    color: "#e07a72",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  },
  confirmTitle: { fontSize: 16.5, fontWeight: 700, color: PAPER, marginBottom: 8 },
  confirmText: { fontSize: 13.5, color: "#9a938d", lineHeight: 1.4, marginBottom: 20 },
  confirmActions: { display: "flex", gap: 10 },
  confirmCancelBtn: {
    flex: 1,
    padding: "13px 0",
    borderRadius: 10,
    border: "1px solid #3a3532",
    background: "transparent",
    color: PAPER,
    fontSize: 14.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  confirmDeleteBtn: {
    flex: 1,
    padding: "13px 0",
    borderRadius: 10,
    border: "none",
    background: "#b3564f",
    color: PAPER,
    fontSize: 14.5,
    fontWeight: 700,
    cursor: "pointer",
  },
};
