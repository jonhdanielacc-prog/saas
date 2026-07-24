import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Shield,
  LogOut,
  Eye,
  Search,
  X,
  Lock,
  Plus,
  Pencil,
  Trash2,
  Check,
  Settings2,
} from "lucide-react";
import { supabase } from "./supabaseClient";
import { ICON_OPTIONS, iconByKey } from "./menuIcons";
import MenuEditor from "./MenuEditor";

const WINE = "#8C2F2A";
const GOLD = "#C9982E";
const INK = "#1B1918";
const PANEL = "#242120";
const PAPER = "#F4EFE6";

const POLL_INTERVAL = 5000;
const HISTORY_RETENTION_DAYS = 14; // сколько дней хранить выполненные заказы в истории
const OVERDUE_MINUTES = 20;

const money = (n) => (n || 0).toLocaleString("ru-RU");
const formatDate = (iso) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

// Экран администратора КОНКРЕТНОГО кафе — открывается после входа "Я
// администратор" на экране выбора официанта (см. AdminMenuGate, требует
// свой PIN, не запоминается). Вкладки вверху, как у официанта: "Активные"
// (заказы ВСЕХ официантов, только просмотр — без права выполнить/удалить),
// "Кухня/Бар" (очередь по рубрикам), "Аналитика", "История", "Стоп-лист"
// (быстрый вкл/выкл по каждому блюду). "Меню" — отдельная защищённая
// вкладка: требует ЕЩЁ РАЗ ввести PIN кафе, который не запоминается даже
// в рамках одной сессии администратора — специально, потому что правки
// меню сразу видят все официанты и клиенты.
// Склонение "день/дня/дней" под число
function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

function TrialBanner({ trialInfo }) {
  if (!trialInfo) return null;
  if (trialInfo.inTrial) {
    return (
      <div
        style={{
          ...styles.trialBanner,
          ...(trialInfo.endingSoon ? styles.trialBannerUrgent : {}),
        }}
      >
        {trialInfo.endingSoon
          ? "⏳ Пробный период заканчивается сегодня — завтра доступ будет отключён, если не продлить подписку."
          : `⏳ Пробный период: осталось ${trialInfo.daysLeft} ${pluralDays(trialInfo.daysLeft)}.`}
      </div>
    );
  }
  if (trialInfo.paidUntil) {
    return (
      <div style={styles.trialBannerPaid}>
        Подписка активна до {new Date(trialInfo.paidUntil).toLocaleDateString("ru-RU")}.
      </div>
    );
  }
  return null;
}

export default function AdminScreen({ restaurantId, restaurantName, restaurantPin, menu, trialInfo, onExit, onMenuUpdated }) {
  const [tab, setTab] = useState("active"); // active | kitchen | stats | done | stop | menu

  const [categories, setCategories] = useState(menu?.categories || []);
  const [items, setItems] = useState(menu?.items || []);
  const [saveError, setSaveError] = useState(null);

  const [allActive, setAllActive] = useState([]);
  const [history, setHistory] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [viewingOrder, setViewingOrder] = useState(null);

  const [stopSearch, setStopSearch] = useState("");

  // Разблокировка вкладки "Меню" НЕ запоминается — при каждом уходе с неё
  // и возврате обратно PIN приходится вводить заново.
  const [menuUnlocked, setMenuUnlocked] = useState(false);
  const [menuPin, setMenuPin] = useState("");
  const [menuPinError, setMenuPinError] = useState(null);
  useEffect(() => {
    if (tab !== "menu") {
      setMenuUnlocked(false);
      setMenuPin("");
      setMenuPinError(null);
    }
  }, [tab]);

  // Внутри "Меню" — рубрика-вкладка для точечного редактирования блюд,
  // плюс отдельная кнопка на полный редактор (рубрики + вставка JSON).
  const [menuCategory, setMenuCategory] = useState(categories[0]?.id || "");
  // itemModal: null | { mode: "add" | "edit", id?, name, price, category }
  const [itemModal, setItemModal] = useState(null);
  const [itemModalError, setItemModalError] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  // categoryModal: null | { mode: "add" | "edit", id?, name, icon }
  const [categoryModal, setCategoryModal] = useState(null);
  const [categoryModalError, setCategoryModalError] = useState(null);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState(null); // объект рубрики или null
  const [showFullEditor, setShowFullEditor] = useState(false);

  // --- Заказы всех официантов (для "Активные"/"Кухня-Бар"/"История"/"Аналитика") ---
  const mapRow = (row) => ({
    id: row.id,
    table: row.table_number,
    waiter: row.waiter,
    date: row.created_at,
    completedDate: row.completed_at,
    itemsCount: row.items_count,
    total: row.total,
    items: row.items || [],
  });

  const fetchOrders = async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false });
    setOrdersLoading(false);
    if (error) {
      setOrdersError(error.message);
      return;
    }
    setOrdersError(null);
    const rows = (data || []).map(mapRow);
    setAllActive(rows.filter((r) => !r.completedDate));
    setHistory(rows.filter((r) => r.completedDate));
  };

  // История хранится ограниченное время — старые выполненные заказы стираются
  // сами, чтобы база не разрасталась бесконечно (см. HISTORY_RETENTION_DAYS).
  const cleanupOldOrders = async () => {
    if (!supabase) return;
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("orders")
      .delete()
      .eq("restaurant_id", restaurantId)
      .lt("completed_at", cutoff);
  };

  useEffect(() => {
    cleanupOldOrders().then(fetchOrders);
    // Поллинг — страховка на случай, если Realtime не настроен в Supabase
    const interval = setInterval(fetchOrders, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [restaurantId]);

  // Realtime — заказы официантов видны сразу, без ожидания следующего опроса
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel(`admin-orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => fetchOrders()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  // Тикающие "часы" — раз в полминуты пересчитываем, сколько прошло с момента
  // создания каждого активного заказа, чтобы подсветить просроченные (20+ мин)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const getElapsedMinutes = (iso) =>
    Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));

  const formatElapsed = (minutes) => {
    if (minutes < 60) return `${minutes} мин`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h} ч ${m} мин`;
  };

  // Звук + вибрация один раз в момент, когда заказ становится просроченным
  const notifiedOverdueRef = useRef(new Set());
  const playOverdueAlert = () => {
    try {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } catch (e) {
      // не критично
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.55);
      oscillator.onended = () => ctx.close();
    } catch (e) {
      // звук не критичен для работы приложения
    }
  };

  useEffect(() => {
    const activeIds = new Set(allActive.map((o) => o.id));
    notifiedOverdueRef.current.forEach((id) => {
      if (!activeIds.has(id)) notifiedOverdueRef.current.delete(id);
    });
    allActive.forEach((entry) => {
      if (
        getElapsedMinutes(entry.date) >= OVERDUE_MINUTES &&
        !notifiedOverdueRef.current.has(entry.id)
      ) {
        notifiedOverdueRef.current.add(entry.id);
        playOverdueAlert();
      }
    });
  }, [now, allActive]);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // Очередь по рубрикам: сколько чего сейчас ждёт готовки, отдельно по
  // каждой рубрике меню (не только еда/бар — сколько рубрик, столько колонок).
  // oldestDate — время самого старого заказа с этим блюдом, чтобы видеть,
  // что готовится дольше всего (и подсветить просроченное, 20+ мин).
  const kitchenQueue = useMemo(() => {
    const buckets = new Map(categories.map((c) => [c.id, new Map()]));
    allActive.forEach((order) => {
      (order.items || []).forEach((it) => {
        const catId = itemsById.get(it.id)?.category;
        const bucket = buckets.get(catId);
        if (!bucket) return; // рубрику потом удалили/переименовали — пропускаем
        const existing = bucket.get(it.id);
        if (existing) {
          existing.qty += it.n;
          existing.tables.push(order.table);
          if (order.date < existing.oldestDate) existing.oldestDate = order.date;
        } else {
          bucket.set(it.id, {
            name: it.name,
            qty: it.n,
            tables: [order.table],
            oldestDate: order.date,
          });
        }
      });
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      list: [...(buckets.get(c.id)?.values() || [])].sort(
        (a, b) => new Date(a.oldestDate) - new Date(b.oldestDate)
      ),
    }));
  }, [allActive, itemsById, categories]);

  const stats = useMemo(() => {
    const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();
    const todayOrders = history.filter((o) => isToday(o.completedDate));
    const totalRevenue = history.reduce((s, o) => s + (o.total || 0), 0);
    const totalOrders = history.length;
    const avgCheck = totalOrders ? Math.round(totalRevenue / totalOrders) : 0;
    const todayRevenue = todayOrders.reduce((s, o) => s + (o.total || 0), 0);

    const itemAgg = {};
    const waiterAgg = {};
    history.forEach((o) => {
      (o.items || []).forEach((it) => {
        const a = itemAgg[it.name] || { name: it.name, qty: 0 };
        a.qty += it.n || 0;
        itemAgg[it.name] = a;
      });
      const w = waiterAgg[o.waiter] || { waiter: o.waiter, count: 0, revenue: 0 };
      w.count += 1;
      w.revenue += o.total || 0;
      waiterAgg[o.waiter] = w;
    });

    return {
      ordersToday: todayOrders.length,
      todayRevenue,
      totalOrders,
      totalRevenue,
      avgCheck,
      topDishes: Object.values(itemAgg).sort((a, b) => b.qty - a.qty).slice(0, 5),
      waiterList: Object.values(waiterAgg).sort((a, b) => b.revenue - a.revenue),
    };
  }, [history]);

  // --- Правки меню — сохраняются сразу в restaurants.menu ---
  // Возвращает null при успехе или текст ошибки при неудаче.
  const persist = async (nextItems, nextCategories = categories) => {
    setSaveError(null);
    const newMenu = { categories: nextCategories, items: nextItems };
    const { error } = await supabase
      .from("restaurants")
      .update({ menu: newMenu, updated_at: new Date().toISOString() })
      .eq("id", restaurantId);
    if (error) {
      setSaveError(error.message);
      return error.message;
    }
    setItems(nextItems);
    setCategories(nextCategories);
    onMenuUpdated(newMenu);
    return null;
  };

  const toggleStop = (item) => {
    persist(items.map((i) => (i.id === item.id ? { ...i, stopped: !i.stopped } : i)));
  };

  const startEdit = (item) => {
    setConfirmDeleteId(null);
    setItemModalError(null);
    setItemModal({ mode: "edit", id: item.id, name: item.name, price: String(item.price ?? ""), category: item.category });
  };

  const openAddItem = () => {
    setItemModalError(null);
    setItemModal({ mode: "add", name: "", price: "", category: menuCategory });
  };

  const submitItemModal = async () => {
    if (!itemModal.name.trim()) {
      setItemModalError("Впишите название блюда.");
      return;
    }
    const price = Number(itemModal.price) || 0;
    let next;
    if (itemModal.mode === "add") {
      const id = `item${Date.now().toString().slice(-6)}`;
      next = [...items, { id, name: itemModal.name.trim(), price, category: itemModal.category }];
    } else {
      next = items.map((i) =>
        i.id === itemModal.id ? { ...i, name: itemModal.name.trim(), price, category: itemModal.category } : i
      );
    }
    const err = await persist(next);
    if (!err) {
      setItemModal(null);
      setMenuCategory(itemModal.category);
    } else {
      setItemModalError(err);
    }
  };

  const deleteMenuItem = async (id) => {
    setConfirmDeleteId(null);
    await persist(items.filter((i) => i.id !== id));
  };

  const openAddCategory = () => {
    setCategoryModalError(null);
    setCategoryModal({ mode: "add", name: "", icon: "package" });
  };

  const startEditCategory = (cat) => {
    setCategoryModalError(null);
    setCategoryModal({ mode: "edit", id: cat.id, name: cat.name, icon: cat.icon });
  };

  const submitCategoryModal = async () => {
    if (!categoryModal.name.trim()) {
      setCategoryModalError("Впишите название рубрики.");
      return;
    }
    let nextCategories;
    let selectedId;
    if (categoryModal.mode === "add") {
      const id = `cat${Date.now().toString().slice(-6)}`;
      selectedId = id;
      nextCategories = [...categories, { id, name: categoryModal.name.trim(), icon: categoryModal.icon }];
    } else {
      selectedId = categoryModal.id;
      nextCategories = categories.map((c) =>
        c.id === categoryModal.id ? { ...c, name: categoryModal.name.trim(), icon: categoryModal.icon } : c
      );
    }
    const err = await persist(items, nextCategories);
    if (!err) {
      setCategoryModal(null);
      setMenuCategory(selectedId);
    } else {
      setCategoryModalError(err);
    }
  };

  const itemCountByCategory = useMemo(() => {
    const map = new Map();
    items.forEach((i) => map.set(i.category, (map.get(i.category) || 0) + 1));
    return map;
  }, [items]);

  const deleteCategory = async (cat) => {
    setConfirmDeleteCategory(null);
    const nextCategories = categories.filter((c) => c.id !== cat.id);
    const nextItems = items.filter((i) => i.category !== cat.id);
    const err = await persist(nextItems, nextCategories);
    if (!err && menuCategory === cat.id) {
      setMenuCategory(nextCategories[0]?.id || "");
    }
  };

  const stopListItems = useMemo(() => {
    const q = stopSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [stopSearch, items]);

  const submitMenuPin = () => {
    if (menuPin.trim().toUpperCase() === String(restaurantPin || "").trim().toUpperCase()) {
      setMenuUnlocked(true);
      setMenuPinError(null);
    } else {
      setMenuPinError("Неверный PIN-код.");
    }
  };

  const tabs = [
    { id: "active", label: `Активные${allActive.length > 0 ? ` (${allActive.length})` : ""}` },
    { id: "kitchen", label: "Кухня/Бар" },
    { id: "stats", label: "Аналитика" },
    { id: "done", label: "История" },
    { id: "stop", label: `Стоп-лист${items.some((i) => i.stopped) ? ` (${items.filter((i) => i.stopped).length})` : ""}` },
    { id: "menu", label: "Меню", locked: true },
  ];

  return (
    <div className="app-shell" style={styles.app}>
      <div style={styles.header}>
        <div style={styles.waiterRow}>
          <div style={styles.waiterBadge}>
            <Shield size={13} strokeWidth={2.4} />
            Администратор
          </div>
          <button style={styles.switchWaiterBtn} onClick={onExit}>
            <LogOut size={13} strokeWidth={2.2} />
            Сменить
          </button>
        </div>
        <TrialBanner trialInfo={trialInfo} />
        <div style={styles.adminTabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              style={{ ...styles.adminTab, ...(tab === t.id ? styles.adminTabActive : {}) }}
              onClick={() => setTab(t.id)}
            >
              {t.locked && <Lock size={12} strokeWidth={2.4} style={{ marginRight: 3 }} />}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.adminBody}>
        {saveError && <div style={styles.saveErrorBanner}>Ошибка сохранения: {saveError}</div>}

        {tab === "active" &&
          (ordersLoading ? (
            <p style={styles.empty}>Загрузка...</p>
          ) : allActive.length === 0 ? (
            <p style={styles.empty}>Сейчас ни у одного официанта нет активных заказов.</p>
          ) : (
            <div style={styles.modalList}>
              {allActive.map((entry) => {
                const elapsed = getElapsedMinutes(entry.date);
                const overdue = elapsed >= OVERDUE_MINUTES;
                return (
                  <div
                    key={entry.id}
                    style={{ ...styles.orderRow, ...(overdue ? styles.orderRowOverdue : {}) }}
                  >
                    <button style={styles.orderRowMain} onClick={() => setViewingOrder(entry)}>
                      <span style={styles.orderTable}>
                        Стол №{entry.table} · {entry.waiter}
                        <span style={{ ...styles.elapsedBadge, ...(overdue ? styles.elapsedBadgeOverdue : {}) }}>
                          {formatElapsed(elapsed)}
                        </span>
                      </span>
                      <span style={styles.orderMeta}>
                        {formatDate(entry.date)} · {entry.itemsCount} поз. · {money(entry.total)} сом
                      </span>
                    </button>
                    <button style={styles.eyeBtn} onClick={() => setViewingOrder(entry)} aria-label="Состав заказа">
                      <Eye size={17} strokeWidth={2.2} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}

        {tab === "done" &&
          (ordersLoading ? (
            <p style={styles.empty}>Загрузка...</p>
          ) : history.length === 0 ? (
            <p style={styles.empty}>Пока нет выполненных заказов.</p>
          ) : (
            <div style={styles.modalList}>
              {history.map((entry) => (
                <div key={entry.id} style={styles.orderRow}>
                  <button style={styles.orderRowMain} onClick={() => setViewingOrder(entry)}>
                    <span style={styles.orderTable}>
                      Стол №{entry.table} · {entry.waiter}
                    </span>
                    <span style={styles.orderMeta}>
                      {formatDate(entry.completedDate || entry.date)} · {entry.itemsCount} поз. · {money(entry.total)} сом
                    </span>
                  </button>
                  <button style={styles.eyeBtn} onClick={() => setViewingOrder(entry)} aria-label="Состав заказа">
                    <Eye size={17} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          ))}

        {tab === "kitchen" && (
          <div style={styles.kitchenCols}>
            {kitchenQueue.map((col) => {
              const ColIcon = iconByKey(col.icon);
              return (
                <div key={col.id} style={styles.kitchenCol}>
                  <div style={styles.kitchenColTitle}>
                    <ColIcon size={15} strokeWidth={2.2} />
                    {col.name || col.id}
                  </div>
                  {col.list.length === 0 ? (
                    <p style={styles.empty}>Ничего не ждёт в этой рубрике.</p>
                  ) : (
                    col.list.map((d) => {
                      const elapsed = getElapsedMinutes(d.oldestDate);
                      const overdue = elapsed >= OVERDUE_MINUTES;
                      return (
                        <div
                          key={d.name}
                          style={{ ...styles.kitchenRow, ...(overdue ? styles.kitchenRowOverdue : {}) }}
                        >
                          <span style={styles.kitchenRowName}>{d.name}</span>
                          <span style={styles.kitchenRowQty}>×{d.qty}</span>
                          <span
                            style={{
                              ...styles.elapsedBadge,
                              ...(overdue ? styles.elapsedBadgeOverdue : {}),
                            }}
                          >
                            {formatElapsed(elapsed)}
                          </span>
                          <span style={styles.kitchenRowTables}>столы: {d.tables.join(", ")}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "stats" && (
          <div>
            <div style={styles.statCards}>
              <div style={styles.statCard}>
                <div style={styles.statValue}>{stats.ordersToday}</div>
                <div style={styles.statLabel}>заказов сегодня</div>
              </div>
              <div style={styles.statCard}>
                <div style={styles.statValue}>{money(stats.todayRevenue)} сом</div>
                <div style={styles.statLabel}>выручка сегодня</div>
              </div>
              <div style={styles.statCard}>
                <div style={styles.statValue}>{money(stats.avgCheck)} сом</div>
                <div style={styles.statLabel}>средний чек</div>
              </div>
              <div style={styles.statCard}>
                <div style={styles.statValue}>{stats.totalOrders}</div>
                <div style={styles.statLabel}>заказов всего</div>
              </div>
            </div>

            <div style={styles.statSectionTitle}>Топ блюд</div>
            {stats.topDishes.length === 0 ? (
              <p style={styles.empty}>Пока нет выполненных заказов.</p>
            ) : (
              <div style={styles.modalList}>
                {stats.topDishes.map((d, idx) => (
                  <div key={d.name} style={styles.statRow}>
                    <span style={styles.statRowRank}>{idx + 1}</span>
                    <span style={styles.statRowName}>{d.name}</span>
                    <span style={styles.statRowValue}>×{d.qty}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.statSectionTitle}>По официантам</div>
            {stats.waiterList.length === 0 ? (
              <p style={styles.empty}>Пока нет данных.</p>
            ) : (
              <div style={styles.modalList}>
                {stats.waiterList.map((w) => (
                  <div key={w.waiter} style={styles.statRow}>
                    <span style={styles.statRowName}>{w.waiter}</span>
                    <span style={styles.statRowValue}>
                      {w.count} зак. · {money(w.revenue)} сом
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "stop" && (
          <>
            <div style={styles.searchRow}>
              <Search size={15} strokeWidth={2.2} color="#8a8480" />
              <input
                style={styles.searchInput}
                placeholder="Поиск по меню..."
                value={stopSearch}
                onChange={(e) => setStopSearch(e.target.value)}
              />
              {stopSearch && (
                <button style={styles.searchClear} onClick={() => setStopSearch("")} aria-label="Очистить поиск">
                  <X size={15} strokeWidth={2.2} />
                </button>
              )}
            </div>
            {stopListItems.length === 0 ? (
              <p style={styles.empty}>Ничего не найдено.</p>
            ) : (
              <div style={styles.modalList}>
                {stopListItems.map((item) => {
                  const CatIcon = iconByKey(categories.find((c) => c.id === item.category)?.icon);
                  return (
                    <div key={item.id} style={styles.stopRow}>
                      <div style={styles.stopRowInfo}>
                        <CatIcon size={14} strokeWidth={2.2} color="#8a8480" />
                        <span style={styles.stopRowName}>{item.name}</span>
                        <span style={styles.stopRowPrice}>{money(item.price)} сом</span>
                      </div>
                      <button
                        style={{ ...styles.stopToggleBtn, ...(item.stopped ? styles.stopToggleBtnActive : {}) }}
                        onClick={() => toggleStop(item)}
                      >
                        {item.stopped ? "Вернуть в меню" : "В стоп-лист"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === "menu" &&
          (!menuUnlocked ? (
            <div style={styles.menuLockBox}>
              <div style={styles.menuLockIcon}>
                <Lock size={22} strokeWidth={2.2} />
              </div>
              <div style={styles.menuLockTitle}>Изменение меню защищено PIN-кодом</div>
              <p style={styles.menuLockWarning}>
                В отличие от обычного входа, этот код не запоминается — его нужно
                вводить каждый раз, когда вы хотите изменить меню. Правки сразу
                видят все официанты и клиенты, поэтому здесь важна лишняя проверка.
              </p>
              <input
                style={styles.menuPinInput}
                type="text"
                maxLength={5}
                placeholder="•••••"
                value={menuPin}
                onChange={(e) => {
                  setMenuPin(e.target.value.replace(/\s/g, "").toUpperCase());
                  setMenuPinError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && submitMenuPin()}
              />
              {menuPinError && <p style={styles.menuPinError}>{menuPinError}</p>}
              <button style={styles.menuUnlockBtn} onClick={submitMenuPin}>
                Разблокировать
              </button>
            </div>
          ) : (
            <>
              <div style={styles.sectionTitle}>Рубрики</div>
              <div style={styles.rubricRow}>
                {categories.map((cat) => {
                  const Icon = iconByKey(cat.icon);
                  const active = menuCategory === cat.id;
                  return (
                    <div key={cat.id} style={styles.rubricChipWrap}>
                      <button
                        style={{ ...styles.rubricChip, ...(active ? styles.rubricChipActive : {}) }}
                        onClick={() => setMenuCategory(cat.id)}
                      >
                        <Icon size={15} strokeWidth={2.2} />
                        {cat.name || cat.id}
                        <span style={{ ...styles.rubricCount, ...(active ? styles.rubricCountActive : {}) }}>
                          {itemCountByCategory.get(cat.id) || 0}
                        </span>
                      </button>
                      {active && (
                        <button
                          style={styles.rubricEditBtn}
                          onClick={() => startEditCategory(cat)}
                          aria-label={`Редактировать рубрику ${cat.name}`}
                        >
                          <Pencil size={13} strokeWidth={2.2} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button style={styles.rubricAddChip} onClick={openAddCategory}>
                  <Plus size={15} strokeWidth={2.4} />
                  Рубрика
                </button>
              </div>

              <button style={styles.fullEditorBtn} onClick={() => setShowFullEditor(true)}>
                <Settings2 size={14} strokeWidth={2.2} />
                Вставить много блюд/рубрик JSON-кодом
              </button>

              {!categories.length ? (
                <p style={styles.empty}>Рубрик пока нет — добавьте хотя бы одну кнопкой выше.</p>
              ) : (
                <>
                  <div style={styles.sectionTitle}>Блюда</div>
                  <div style={styles.grid}>
                    {items
                      .filter((i) => i.category === menuCategory)
                      .map((item) => (
                        <div key={item.id} style={{ ...styles.card, ...(item.stopped ? styles.cardStopped : {}) }}>
                          <div style={styles.cardName}>
                            {item.name}
                            {item.stopped && <span style={styles.stopBadge}>СТОП</span>}
                          </div>
                          <div style={styles.cardPrice}>{money(item.price)} сом</div>
                          <div style={styles.cardActions}>
                            {confirmDeleteId === item.id ? (
                              <>
                                <button style={styles.actionIconBtn} onClick={() => deleteMenuItem(item.id)} aria-label="Да, удалить">
                                  <Check size={15} strokeWidth={2.4} color="#e07a72" />
                                </button>
                                <button style={styles.actionIconBtn} onClick={() => setConfirmDeleteId(null)} aria-label="Отмена">
                                  <X size={15} strokeWidth={2.4} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button style={styles.actionIconBtn} onClick={() => startEdit(item)} aria-label={`Редактировать ${item.name}`}>
                                  <Pencil size={14} strokeWidth={2.2} />
                                </button>
                                <button style={styles.actionIconBtn} onClick={() => setConfirmDeleteId(item.id)} aria-label={`Удалить ${item.name}`}>
                                  <Trash2 size={14} strokeWidth={2.2} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    <button style={styles.addCard} onClick={openAddItem}>
                      <Plus size={20} strokeWidth={2.4} />
                      Добавить блюдо
                    </button>
                  </div>
                </>
              )}
            </>
          ))}
      </div>

      {viewingOrder && (
        <div style={styles.overlay} onClick={() => setViewingOrder(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.modalTitle}>Стол №{viewingOrder.table}</div>
                <div style={styles.orderMeta}>
                  {formatDate(viewingOrder.completedDate || viewingOrder.date)} · {viewingOrder.waiter}
                </div>
              </div>
              <button style={styles.iconOnlyBtn} onClick={() => setViewingOrder(null)}>
                <X size={20} />
              </button>
            </div>
            <div style={styles.modalBody}>
              {(() => {
                const orderItems = viewingOrder.items || [];
                const maxBatch = Math.max(0, ...orderItems.map((i) => i.batch || 0));
                return orderItems.map((i, idx) => {
                  const isNew = maxBatch > 0 && (i.batch || 0) === maxBatch;
                  return (
                    <div key={`${i.id}-${idx}`} style={styles.statRow}>
                      <span>
                        {i.n}× {i.name}
                        {isNew && <span style={styles.newBadge}>Новое</span>}
                      </span>
                      <span style={styles.statRowValue}>{money(i.price * i.n)} сом</span>
                    </div>
                  );
                });
              })()}
              <div style={{ ...styles.statRow, fontWeight: 700, marginTop: 8 }}>
                <span>Итого</span>
                <span>{money(viewingOrder.total)} сом</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showFullEditor && (
        <MenuEditor
          restaurantId={restaurantId}
          initialMenu={{ categories, items }}
          onClose={() => setShowFullEditor(false)}
          onSaved={(newMenu) => {
            setCategories(newMenu.categories);
            setItems(newMenu.items);
            if (!newMenu.categories.some((c) => c.id === menuCategory)) {
              setMenuCategory(newMenu.categories[0]?.id || "");
            }
            onMenuUpdated(newMenu);
          }}
        />
      )}

      {itemModal && (
        <div style={styles.overlay} onClick={() => setItemModal(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{itemModal.mode === "add" ? "Новое блюдо" : "Редактировать блюдо"}</span>
              <button style={styles.iconOnlyBtn} onClick={() => setItemModal(null)}>
                <X size={20} />
              </button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.fieldLabel}>Название</label>
              <input
                style={styles.fieldInput}
                value={itemModal.name}
                placeholder="Например: Плов с бараниной"
                autoFocus
                onChange={(e) => setItemModal((m) => ({ ...m, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && submitItemModal()}
              />

              <label style={styles.fieldLabel}>Цена</label>
              <div style={styles.priceInputWrap}>
                <input
                  style={styles.priceInput}
                  type="text"
                  inputMode="decimal"
                  value={itemModal.price}
                  placeholder="0"
                  onChange={(e) => setItemModal((m) => ({ ...m, price: e.target.value.replace(/[^0-9]/g, "") }))}
                  onKeyDown={(e) => e.key === "Enter" && submitItemModal()}
                />
                <span style={styles.priceSuffix}>сом</span>
              </div>

              <label style={styles.fieldLabel}>Рубрика</label>
              <div style={styles.categoryPicker}>
                {categories.map((cat) => {
                  const Icon = iconByKey(cat.icon);
                  const active = itemModal.category === cat.id;
                  return (
                    <button
                      key={cat.id}
                      style={{ ...styles.categoryCard, ...(active ? styles.categoryCardActive : {}) }}
                      onClick={() => setItemModal((m) => ({ ...m, category: cat.id }))}
                    >
                      <Icon size={18} strokeWidth={2.2} />
                      <span style={styles.categoryCardLabel}>{cat.name || cat.id}</span>
                    </button>
                  );
                })}
              </div>

              {itemModalError && <div style={styles.saveError}>{itemModalError}</div>}
            </div>
            <div style={styles.modalFooter}>
              <button style={styles.cancelBtn} onClick={() => setItemModal(null)}>
                Отмена
              </button>
              <button style={styles.saveBtn} onClick={submitItemModal}>
                <Check size={16} strokeWidth={2.4} />
                {itemModal.mode === "add" ? "Добавить" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {categoryModal && (
        <div style={styles.overlay} onClick={() => setCategoryModal(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{categoryModal.mode === "add" ? "Новая рубрика" : "Редактировать рубрику"}</span>
              <button style={styles.iconOnlyBtn} onClick={() => setCategoryModal(null)}>
                <X size={20} />
              </button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.fieldLabel}>Название</label>
              <input
                style={styles.fieldInput}
                value={categoryModal.name}
                placeholder="Например: Кухня, Напитки, Бар"
                autoFocus
                onChange={(e) => setCategoryModal((m) => ({ ...m, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && submitCategoryModal()}
              />

              <label style={styles.fieldLabel}>Иконка</label>
              <div style={styles.iconPicker}>
                {ICON_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    style={{ ...styles.iconOption, ...(categoryModal.icon === o.key ? styles.iconOptionActive : {}) }}
                    onClick={() => setCategoryModal((m) => ({ ...m, icon: o.key }))}
                    aria-label={o.label}
                    title={o.label}
                  >
                    <o.Icon size={20} strokeWidth={2.2} />
                  </button>
                ))}
              </div>

              {categoryModalError && <div style={styles.saveError}>{categoryModalError}</div>}

              {categoryModal.mode === "edit" && (
                <button
                  style={styles.deleteCategoryBtn}
                  onClick={() => {
                    const cat = categories.find((c) => c.id === categoryModal.id);
                    setCategoryModal(null);
                    setConfirmDeleteCategory(cat);
                  }}
                >
                  <Trash2 size={14} strokeWidth={2.2} />
                  Удалить рубрику
                </button>
              )}
            </div>
            <div style={styles.modalFooter}>
              <button style={styles.cancelBtn} onClick={() => setCategoryModal(null)}>
                Отмена
              </button>
              <button style={styles.saveBtn} onClick={submitCategoryModal}>
                <Check size={16} strokeWidth={2.4} />
                {categoryModal.mode === "add" ? "Добавить" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteCategory && (
        <div style={{ ...styles.overlay, alignItems: "center" }} onClick={() => setConfirmDeleteCategory(null)}>
          <div style={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.confirmIcon}>
              <Trash2 size={22} strokeWidth={2.2} />
            </div>
            <div style={styles.confirmTitle}>Удалить рубрику «{confirmDeleteCategory.name}»?</div>
            <div style={styles.confirmText}>
              {itemCountByCategory.get(confirmDeleteCategory.id)
                ? `Вместе с рубрикой будут удалены все блюда в ней (${itemCountByCategory.get(confirmDeleteCategory.id)}). `
                : ""}
              Официанты сразу перестанут видеть эту рубрику в меню.
            </div>
            <div style={styles.confirmActions}>
              <button style={styles.cancelBtn} onClick={() => setConfirmDeleteCategory(null)}>
                Оставить
              </button>
              <button style={styles.confirmDeleteBtn} onClick={() => deleteCategory(confirmDeleteCategory)}>
                Да, удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
    padding: "10px 14px 0",
    position: "sticky",
    top: 0,
    background: INK,
    zIndex: 5,
    borderBottom: "1px solid #35312e",
  },
  waiterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 10 },
  waiterBadge: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    fontWeight: 600,
    color: "#c9c4bf",
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 20,
    padding: "4px 10px",
  },
  switchWaiterBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
    color: "#8a8480",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px 2px",
  },
  trialBanner: {
    fontSize: 12,
    color: GOLD,
    background: "rgba(201,152,46,0.12)",
    border: "1px solid rgba(201,152,46,0.4)",
    borderRadius: 10,
    padding: "8px 10px",
    lineHeight: 1.4,
    marginBottom: 10,
  },
  trialBannerUrgent: {
    color: "#e07a72",
    background: "rgba(179,86,79,0.14)",
    border: "1px solid rgba(179,86,79,0.5)",
  },
  trialBannerPaid: {
    fontSize: 11.5,
    color: "#7fbf8f",
    background: "rgba(127,191,143,0.1)",
    border: "1px solid rgba(127,191,143,0.35)",
    borderRadius: 10,
    padding: "7px 10px",
    lineHeight: 1.4,
    marginBottom: 10,
  },
  adminTabs: { display: "flex", gap: 6, overflowX: "auto", paddingBottom: 10, WebkitOverflowScrolling: "touch" },
  adminTab: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    padding: "8px 12px",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    background: "transparent",
    color: "#9a938d",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  adminTabActive: { background: WINE, borderColor: WINE, color: PAPER },
  adminBody: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 16px 24px" },
  iconOnlyBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    background: "transparent",
    border: "1px solid #3a3532",
    borderRadius: 8,
    color: "#c9c4bf",
    cursor: "pointer",
  },
  saveErrorBanner: {
    background: "rgba(179,86,79,0.14)",
    border: "1px solid #b3564f",
    color: "#e07a72",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12.5,
    marginBottom: 12,
  },
  empty: { color: "#8a8480", fontSize: 13.5, textAlign: "center", padding: "20px 0" },
  modalList: { display: "flex", flexDirection: "column" },
  orderRow: { display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid #322e2b" },
  orderRowOverdue: {
    background: "rgba(179,86,79,0.12)",
    borderBottom: "1px solid rgba(179,86,79,0.4)",
    borderRadius: 8,
    padding: "8px 6px",
    margin: "0 -6px",
  },
  orderRowMain: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    background: "none",
    border: "none",
    color: PAPER,
    cursor: "pointer",
    textAlign: "left",
  },
  orderTable: { fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 },
  orderMeta: { fontSize: 11.5, color: "#8a8480" },
  elapsedBadge: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "#9a938d",
    background: "#1B1918",
    borderRadius: 20,
    padding: "2px 8px",
  },
  elapsedBadgeOverdue: { color: "#e07a72", background: "rgba(179,86,79,0.18)" },
  newBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: GOLD,
    background: "rgba(201,152,46,0.15)",
    borderRadius: 20,
    padding: "1px 7px",
    marginLeft: 6,
  },
  eyeBtn: { background: "none", border: "none", color: "#8a8480", cursor: "pointer", display: "flex", flexShrink: 0 },
  kitchenCols: { display: "flex", flexDirection: "column", gap: 22 },
  kitchenCol: { display: "flex", flexDirection: "column", gap: 8 },
  kitchenColTitle: { display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: PAPER, marginBottom: 2 },
  kitchenRow: { display: "flex", alignItems: "baseline", gap: 8, borderBottom: "1px solid #35312e", paddingBottom: 8, fontSize: 13.5 },
  kitchenRowOverdue: {
    background: "rgba(179,86,79,0.12)",
    borderBottom: "1px solid rgba(179,86,79,0.4)",
    borderRadius: 8,
    padding: "6px 6px 8px",
    margin: "0 -6px",
  },
  kitchenRowName: { flex: 1, color: PAPER, fontWeight: 600 },
  kitchenRowQty: { color: GOLD, fontWeight: 700 },
  kitchenRowTables: { color: "#8a8480", fontSize: 12, flexShrink: 0 },
  statCards: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 },
  statCard: { background: PANEL, border: "1px solid #3a3532", borderRadius: 12, padding: "14px 12px", textAlign: "center" },
  statValue: { fontSize: 20, fontWeight: 700, color: GOLD, marginBottom: 4 },
  statLabel: { fontSize: 11.5, color: "#9a938d" },
  statSectionTitle: { fontSize: 14, fontWeight: 700, color: PAPER, margin: "4px 0 10px" },
  statRow: { display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #35312e", paddingBottom: 9, fontSize: 13.5 },
  statRowRank: { width: 18, color: "#8a8480", fontWeight: 700 },
  statRowName: { flex: 1, color: PAPER, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  statRowValue: { color: GOLD, fontWeight: 600, flexShrink: 0 },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "9px 12px",
    marginBottom: 12,
  },
  searchInput: { flex: 1, background: "transparent", border: "none", outline: "none", color: PAPER, fontSize: 14.5 },
  searchClear: { background: "none", border: "none", color: "#8a8480", cursor: "pointer", padding: 2, display: "flex" },
  stopRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderBottom: "1px solid #35312e", paddingBottom: 10, paddingTop: 10 },
  stopRowInfo: { display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 },
  stopRowName: { fontSize: 14, color: PAPER, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  stopRowPrice: { fontSize: 12.5, color: "#8a8480", flexShrink: 0 },
  stopToggleBtn: {
    flexShrink: 0,
    padding: "8px 12px",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    background: "transparent",
    color: "#9a938d",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  stopToggleBtnActive: { background: "#b3564f", borderColor: "#b3564f", color: PAPER },
  menuLockBox: { textAlign: "center", padding: "20px 10px" },
  menuLockIcon: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "rgba(201,152,46,0.15)",
    color: GOLD,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  },
  menuLockTitle: { fontSize: 15.5, fontWeight: 700, color: PAPER, marginBottom: 10 },
  menuLockWarning: { fontSize: 12.5, color: "#9a938d", lineHeight: 1.5, marginBottom: 18, textAlign: "left" },
  menuPinInput: {
    width: "100%",
    boxSizing: "border-box",
    background: INK,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "12px",
    color: PAPER,
    fontSize: 20,
    letterSpacing: "0.3em",
    textAlign: "center",
    marginBottom: 10,
  },
  menuPinError: { color: "#e07a72", fontSize: 12.5, marginTop: -4, marginBottom: 10 },
  menuUnlockBtn: { width: "100%", padding: "12px 0", borderRadius: 10, border: "none", background: WINE, color: PAPER, fontSize: 14, fontWeight: 700, cursor: "pointer" },
  fullEditorBtn: {
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
    width: "100%",
    marginBottom: 14,
  },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: PAPER, margin: "0 0 8px" },
  rubricRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 14 },
  rubricChipWrap: { display: "flex", alignItems: "center", gap: 5 },
  rubricChip: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 13px",
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    background: "transparent",
    color: "#c9c4bf",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  rubricChipActive: { background: WINE, borderColor: WINE, color: PAPER },
  rubricCount: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "#8a8480",
    background: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    padding: "1px 6px",
  },
  rubricCountActive: { color: PAPER, background: "rgba(0,0,0,0.18)" },
  rubricEditBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    flexShrink: 0,
    borderRadius: "50%",
    border: "none",
    background: PANEL,
    color: GOLD,
    cursor: "pointer",
  },
  rubricAddChip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 13px",
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#5a5450",
    background: "transparent",
    color: "#9a938d",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  iconPicker: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 },
  iconOption: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "1 / 1",
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    background: "transparent",
    color: "#c9c4bf",
    cursor: "pointer",
  },
  iconOptionActive: { background: WINE, borderColor: WINE, color: PAPER },
  deleteCategoryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    marginTop: 18,
    padding: "10px 0",
    borderRadius: 10,
    border: "1px solid #b3564f",
    background: "none",
    color: "#e07a72",
    fontSize: 13,
    fontWeight: 600,
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
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 },
  card: {
    background: PANEL,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    borderRadius: 12,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  cardStopped: { opacity: 0.55, borderColor: "#b3564f" },
  cardName: { fontSize: 13.5, fontWeight: 600, color: PAPER, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  stopBadge: { fontSize: 9, fontWeight: 700, color: "#e07a72", background: "rgba(224,122,114,0.15)", borderRadius: 6, padding: "1px 5px" },
  cardPrice: { fontSize: 13, color: GOLD, fontWeight: 700 },
  cardActions: { display: "flex", gap: 4, marginTop: 2 },
  actionIconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 7,
    color: "#c9c4bf",
    cursor: "pointer",
  },
  addCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 88,
    background: "none",
    border: "1px dashed #3a3532",
    borderRadius: 12,
    color: "#9a938d",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 30 },
  modal: { width: "100%", maxWidth: 480, background: PANEL, borderRadius: "18px 18px 0 0", maxHeight: "82vh", display: "flex", flexDirection: "column" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: "1px solid #3a3532" },
  modalTitle: { fontSize: 15, fontWeight: 700, color: PAPER },
  modalBody: { padding: "12px 18px 20px", overflowY: "auto", flex: 1 },
  modalFooter: { display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid #3a3532" },
  fieldLabel: { display: "block", fontSize: 12, color: "#9a938d", marginBottom: 6, marginTop: 14 },
  fieldInput: {
    width: "100%",
    boxSizing: "border-box",
    background: INK,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    borderRadius: 10,
    padding: "12px 14px",
    color: PAPER,
    fontSize: 16,
  },
  priceInputWrap: { position: "relative" },
  priceInput: {
    width: "100%",
    boxSizing: "border-box",
    background: INK,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    borderRadius: 10,
    padding: "12px 52px 12px 14px",
    color: PAPER,
    fontSize: 16,
  },
  priceSuffix: {
    position: "absolute",
    right: 14,
    top: "50%",
    transform: "translateY(-50%)",
    color: "#8a8480",
    fontSize: 14,
    pointerEvents: "none",
  },
  categoryPicker: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 },
  categoryCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    padding: "12px 6px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3532",
    background: "transparent",
    color: "#c9c4bf",
    cursor: "pointer",
  },
  categoryCardActive: { background: WINE, borderColor: WINE, color: PAPER },
  categoryCardLabel: {
    fontSize: 12,
    fontWeight: 600,
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
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
};
