import React, { useState, useMemo, useRef, useEffect } from "react";
import { Plus, Minus, ChevronLeft, ChevronRight, X, Check, MessageSquarePlus, MessageSquareText, History, Trash2, Eye, User, LogOut, WifiOff, ShieldCheck, Search } from "lucide-react";
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import {
  getCachedRestaurantId,
  setCachedRestaurantId,
  fetchRestaurantByPin,
  fetchRestaurantById,
} from "./restaurant";
import { iconByKey } from "./menuIcons";
import AdminMenuGate from "./AdminMenuEditor";

// Ключ "icon" в меню кафе должен быть одним из ключей menuIcons.ICON_OPTIONS.
const getCategoryIcon = iconByKey;

const WAITER_NAMES = ["Официант 1", "Официант 2", "Официант 3", "Официант 4"];
const POLL_INTERVAL = 5000; // мс — как часто подтягивать заказы других официантов
const HISTORY_RETENTION_DAYS = 14; // сколько дней хранить выполненные заказы в истории

// Карточка всегда одной высоты — это то, что делает расчет страниц предсказуемым
const CARD_H = 110; // px, высота карточки блюда — компактнее, но еще удобно попадать пальцем в +/-
const MIN_CARD_W = 156; // px, минимальная ширина карточки
const GRID_GAP = 10; // px, зазор между карточками

// Порядок рубрик для официанта: сначала основные блюда, затем всё остальное,
// в середине — бар/напитки, в конце — снеки/закуски. Определяется по
// названию рубрики (категории у каждого кафе свои, это не жесткий тип, а
// иконка сама по себе не отличает "закуски" от "основных блюд").
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

function OrderScreen({
  waiterName,
  onSwitchWaiter,
  restaurantId,
  restaurantName,
  categories,
  items: menuItems,
}) {
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => categoryRank(a) - categoryRank(b)),
    [categories]
  );
  const [category, setCategory] = useState(sortedCategories[0]?.id || "food");
  const [tableNumber, setTableNumber] = useState(1);
  const [page, setPage] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [qty, setQty] = useState({});
  const [comments, setComments] = useState({});
  const [commentDraft, setCommentDraft] = useState("");
  const [editingComment, setEditingComment] = useState(null); // id блюда, для которого открыт ввод
  const [showSummary, setShowSummary] = useState(false);
  const [sent, setSent] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [ordersTab, setOrdersTab] = useState("active"); // "active" | "done"
  const [allActiveOrders, setAllActiveOrders] = useState([]); // активные ВСЕХ официантов (нужно для блокировки стола)
  const [orderHistory, setOrderHistory] = useState([]); // история — общая на всех
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  // Только СВОИ активные заказы этот официант видит в списке "Активные"
  const activeOrders = useMemo(
    () => allActiveOrders.filter((o) => o.waiter === waiterName),
    [allActiveOrders, waiterName]
  );

  // --- Общая база данных (Supabase): активные заказы + история, видны всем официантам ---
  // Черновик текущего набираемого заказа остается локальным на устройстве — свой у каждого официанта
  const DRAFT_KEY = `waiter-draft-${waiterName}`;

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
    if (error) {
      setOrdersError(error.message);
      return;
    }
    setOrdersError(null);
    const rows = (data || []).map(mapRow);
    setAllActiveOrders(rows.filter((r) => !r.completedDate));
    setOrderHistory(rows.filter((r) => r.completedDate));
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
    let cancelled = false;
    (async () => {
      await cleanupOldOrders();
      await fetchOrders();
      if (!cancelled) setOrdersLoading(false);
    })();
    // Поллинг остается страховкой на случай, если Realtime не настроен в Supabase
    // (нужно alter publication supabase_realtime add table orders — см. README)
    const interval = setInterval(fetchOrders, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Realtime — заказы других официантов (новые/выполненные/отмененные) видны сразу,
  // без ожидания следующего опроса
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel(`orders-${restaurantId}`)
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

  // Черновик (еще не отправленный заказ) — грузим и сохраняем локально, отдельно на каждого официанта
  useEffect(() => {
    try {
      const draftRaw = localStorage.getItem(DRAFT_KEY);
      if (draftRaw) {
        const draft = JSON.parse(draftRaw);
        if (draft.category) setCategory(draft.category);
        if (typeof draft.tableNumber === "number")
          setTableNumber(draft.tableNumber);
        if (typeof draft.page === "number") setPage(draft.page);
        if (draft.qty) setQty(draft.qty);
        if (draft.comments) setComments(draft.comments);
      }
    } catch (e) {
      console.error("Не удалось прочитать черновик заказа", e);
    } finally {
      setDraftLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    const timeout = setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ category, tableNumber, page, qty, comments })
        );
      } catch (e) {
        console.error("Не удалось сохранить черновик заказа", e);
      }
    }, 400);
    return () => clearTimeout(timeout);
  }, [category, tableNumber, page, qty, comments, draftLoaded]);

  // Новый заказ отправлен — становится активным (виден только этому официанту) и блокирует стол для всех
  const addActiveOrder = async (entry) => {
    const optimistic = { ...entry, waiter: waiterName };
    setAllActiveOrders((prev) => [optimistic, ...prev]);
    if (!supabase) return;
    const { error } = await supabase.from("orders").insert([
      {
        id: entry.id,
        restaurant_id: restaurantId,
        waiter: waiterName,
        table_number: entry.table,
        items: entry.items,
        items_count: entry.itemsCount,
        total: entry.total,
        created_at: entry.date,
      },
    ]);
    if (error) setOrdersError(error.message);
    fetchOrders();
  };

  // Заказ выполнен — уходит из активных в общую историю, стол освобождается
  const completeOrder = async (id) => {
    const order = allActiveOrders.find((e) => e.id === id);
    const completedDate = new Date().toISOString();
    setAllActiveOrders((prev) => prev.filter((e) => e.id !== id));
    if (order) {
      setOrderHistory((prev) => [{ ...order, completedDate }, ...prev]);
    }
    if (!supabase) return;
    const { error } = await supabase
      .from("orders")
      .update({ completed_at: completedDate })
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (error) setOrdersError(error.message);
    fetchOrders();
  };

  // Отмена активного заказа без выполнения — освобождает стол, в историю не идет
  const cancelActiveOrder = async (id) => {
    setAllActiveOrders((prev) => prev.filter((e) => e.id !== id));
    if (!supabase) return;
    const { error } = await supabase
      .from("orders")
      .delete()
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (error) setOrdersError(error.message);
  };

  const [viewingOrder, setViewingOrder] = useState(null);
  const [confirmingCancel, setConfirmingCancel] = useState(null); // заказ, который собираются отменить
  const [addToOrderId, setAddToOrderId] = useState(null); // id активного заказа, к которому сейчас добавляем позиции

  // Довешиваем новые позиции к уже отправленному активному заказу (не создавая новый)
  const appendToActiveOrder = async (id, newItems, addedCount, addedSum) => {
    const existing = allActiveOrders.find((e) => e.id === id);
    if (!existing) return;
    const mergedItems = [...existing.items, ...newItems];
    const mergedCount = existing.itemsCount + addedCount;
    const mergedTotal = existing.total + addedSum;
    setAllActiveOrders((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, items: mergedItems, itemsCount: mergedCount, total: mergedTotal }
          : e
      )
    );
    if (!supabase) return;
    const { error } = await supabase
      .from("orders")
      .update({ items: mergedItems, items_count: mergedCount, total: mergedTotal })
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (error) setOrdersError(error.message);
    fetchOrders();
  };

  const startAddToOrder = (entry) => {
    setTableNumber(entry.table);
    setAddToOrderId(entry.id);
    setQty({});
    setComments({});
    setShowOrders(false);
    setCategory(sortedCategories[0]?.id || "food");
    setPage(0);
  };

  // --- Адаптивная сетка: считаем, сколько карточек влезает без скролла ---
  const gridRef = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () =>
      setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  // Сетка — 2 колонки, до 4 строк (8 блюд/страница). Если 4 строки карточек
  // высотой CARD_H не помещаются без скролла — строк меньше, лишние блюда уходят на следующую страницу.
  const columns = 2;
  const rows = box.height
    ? Math.max(1, Math.min(4, Math.floor((box.height + GRID_GAP) / (CARD_H + GRID_GAP))))
    : 4;
  const pageSize = columns * rows;
  const rowHeight = box.height
    ? (box.height - GRID_GAP * (rows - 1)) / rows
    : CARD_H;

  const trimmedSearch = searchQuery.trim().toLowerCase();
  const items = trimmedSearch
    ? menuItems.filter((i) => i.name.toLowerCase().includes(trimmedSearch))
    : menuItems.filter((i) => i.category === category);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  // Если после смены ориентации/размера/поиска текущая страница вышла за пределы — подрезаем
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    setPage(0);
  }, [trimmedSearch]);

  const closeSearch = () => {
    setShowSearch(false);
    setSearchQuery("");
  };

  const pageItems = useMemo(
    () => items.slice(page * pageSize, page * pageSize + pageSize),
    [items, page, pageSize]
  );

  const allItemsById = useMemo(() => {
    const map = {};
    menuItems.forEach((i) => (map[i.id] = i));
    return map;
  }, [menuItems]);

  // Пока добавляем позиции к уже отправленному заказу — сколько каждого блюда
  // в нем уже есть, чтобы показать это в сетке (не добавляется автоматически в выбор)
  const alreadyOrderedQty = useMemo(() => {
    if (!addToOrderId) return {};
    const target = allActiveOrders.find((e) => e.id === addToOrderId);
    if (!target) return {};
    const map = {};
    (target.items || []).forEach((i) => {
      map[i.id] = (map[i.id] || 0) + i.n;
    });
    return map;
  }, [addToOrderId, allActiveOrders]);

  const totalCount = Object.values(qty).reduce((a, b) => a + b, 0);
  const totalSum = Object.entries(qty).reduce(
    (sum, [id, n]) => sum + (allItemsById[id]?.price || 0) * n,
    0
  );

  const changeQty = (id, delta) => {
    setQty((prev) => {
      const next = { ...prev };
      const current = next[id] || 0;
      const updated = Math.max(0, current + delta);
      if (updated === 0) delete next[id];
      else next[id] = updated;
      return next;
    });
  };

  const switchCategory = (cat) => {
    setCategory(cat);
    setPage(0);
  };

  const changeTable = (delta) => {
    setTableNumber((n) => Math.min(99, Math.max(1, n + delta)));
    setQty({});
    setComments({});
  };

  const openComment = (item) => {
    setCommentDraft(comments[item.id] || "");
    setEditingComment(item);
  };

  const saveComment = () => {
    setComments((prev) => {
      const next = { ...prev };
      const text = commentDraft.trim();
      if (text) next[editingComment.id] = text;
      else delete next[editingComment.id];
      return next;
    });
    setEditingComment(null);
  };

  const quickComments = ["Без лука", "Острое", "Без специй", "Срочно", "Отдельно"];

  const selectedList = Object.entries(qty)
    .map(([id, n]) => ({ ...allItemsById[id], n }))
    .filter((i) => i.n > 0);

  const money = (n) => n.toLocaleString("ru-RU");

  // Стол считается занятым, если по нему есть активный (еще не выполненный) заказ
  // У ЛЮБОГО официанта — повторно оформить заказ на него нельзя, пока его не выполнят или не отменят
  // Исключение — если сейчас именно к этому заказу и добавляются новые позиции (addToOrderId)
  const activeTableEntry = allActiveOrders.find((e) => e.table === tableNumber);
  const isTableLocked =
    Boolean(activeTableEntry) && activeTableEntry.id !== addToOrderId;

  const formatDate = (iso) =>
    new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  // Тикающие "часы" — раз в полминуты пересчитываем, сколько прошло с момента
  // создания каждого активного заказа, чтобы подсветить просроченные (20+ мин)
  const OVERDUE_MINUTES = 20;
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

  // Звук + вибрация один раз в момент, когда заказ становится просроченным (20+ мин),
  // чтобы официант не пропустил это, не заходя каждый раз в список заказов
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
    const activeIds = new Set(activeOrders.map((o) => o.id));
    notifiedOverdueRef.current.forEach((id) => {
      if (!activeIds.has(id)) notifiedOverdueRef.current.delete(id);
    });
    activeOrders.forEach((entry) => {
      if (
        getElapsedMinutes(entry.date) >= OVERDUE_MINUTES &&
        !notifiedOverdueRef.current.has(entry.id)
      ) {
        notifiedOverdueRef.current.add(entry.id);
        playOverdueAlert();
      }
    });
  }, [now, activeOrders]);

  return (
    <div style={styles.app}>
      {/* Header — компактный, один ряд */}
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.headerLeft}>
            <span style={styles.restaurantLabel}>{restaurantName}</span>
            <div style={styles.waiterBadge}>
              <User size={12} strokeWidth={2.4} />
              {waiterName}
            </div>
            <button style={styles.switchWaiterBtn} onClick={onSwitchWaiter} aria-label="Сменить официанта">
              <LogOut size={12} strokeWidth={2.2} />
            </button>
          </div>
          <div style={styles.headerRight}>
            {ordersError && (
              <span style={styles.syncWarning} title={ordersError}>
                <WifiOff size={13} strokeWidth={2.2} />
              </span>
            )}
            <div
              style={{
                ...styles.tableStepper,
                ...(isTableLocked ? styles.tableStepperLocked : {}),
              }}
            >
              <button
                style={{ ...styles.tableBtn, opacity: addToOrderId ? 0.35 : 1 }}
                onClick={() => changeTable(-1)}
                disabled={Boolean(addToOrderId)}
                aria-label="Предыдущий стол"
              >
                <Minus size={16} strokeWidth={3} />
              </button>
              <span
                style={{
                  ...styles.tableNum,
                  ...(isTableLocked ? styles.tableNumLocked : {}),
                }}
              >
                №{tableNumber}
              </span>
              <button
                style={{ ...styles.tableBtn, opacity: addToOrderId ? 0.35 : 1 }}
                onClick={() => changeTable(1)}
                disabled={Boolean(addToOrderId)}
                aria-label="Следующий стол"
              >
                <Plus size={16} strokeWidth={3} />
              </button>
            </div>
            <button
              style={{
                ...styles.historyBtn,
                ...(showSearch ? styles.searchBtnActive : {}),
              }}
              onClick={() =>
                showSearch ? closeSearch() : setShowSearch(true)
              }
              aria-label="Поиск блюд"
            >
              <Search size={16} strokeWidth={2.2} />
            </button>
            <button
              style={styles.historyBtn}
              onClick={() => setShowOrders(true)}
              aria-label="Заказы"
            >
              <History size={16} strokeWidth={2.2} />
              {activeOrders.length > 0 && (
                <span style={styles.historyBadge}>{activeOrders.length}</span>
              )}
            </button>
          </div>
        </div>
        {showSearch ? (
          <div style={styles.searchRow}>
            <Search size={15} strokeWidth={2.2} color="#8a8480" />
            <input
              style={styles.searchInput}
              placeholder="Поиск блюда..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            <button
              style={styles.searchCloseBtn}
              onClick={closeSearch}
              aria-label="Закрыть поиск"
            >
              <X size={16} strokeWidth={2.2} />
            </button>
          </div>
        ) : (
          <div style={styles.tabs}>
            {sortedCategories.map((cat) => {
              const Icon = getCategoryIcon(cat.icon);
              return (
                <button
                  key={cat.id}
                  style={{
                    ...styles.tab,
                    ...(category === cat.id ? styles.tabActive : {}),
                  }}
                  onClick={() => switchCategory(cat.id)}
                >
                  <Icon size={16} strokeWidth={2.2} />
                  {cat.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Grid */}
      <div style={styles.gridWrap}>
        <div
          ref={gridRef}
          style={{
            ...styles.grid,
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gridAutoRows: `${rowHeight}px`,
          }}
        >
          {pageItems.map((item) => {
            const n = qty[item.id] || 0;
            const stopped = Boolean(item.stopped);
            const alreadyN = alreadyOrderedQty[item.id] || 0;
            return (
              <div
                key={item.id}
                style={{
                  ...styles.card,
                  ...(n > 0 ? styles.cardActive : {}),
                  ...(stopped ? styles.cardStopped : {}),
                }}
              >
                <div style={styles.cardTop}>
                  <div style={styles.cardNameRow}>
                    <div style={styles.cardName}>
                      {item.name}
                      {alreadyN > 0 && (
                        <span style={styles.alreadyOrderedBadge}>
                          уже {alreadyN}
                        </span>
                      )}
                    </div>
                    <button
                      style={{
                        ...styles.commentBtn,
                        ...(comments[item.id] ? styles.commentBtnActive : {}),
                      }}
                      onClick={() => openComment(item)}
                      aria-label={`Комментарий к ${item.name}`}
                    >
                      {comments[item.id] ? (
                        <MessageSquareText size={13} strokeWidth={2.2} />
                      ) : (
                        <MessageSquarePlus size={13} strokeWidth={2.2} />
                      )}
                    </button>
                  </div>
                  {comments[item.id] && (
                    <div style={styles.cardComment}>{comments[item.id]}</div>
                  )}
                  <div style={styles.cardPrice}>{money(item.price)} сом</div>
                </div>
                {stopped ? (
                  <div style={styles.stoppedBadge}>Стоп-лист</div>
                ) : (
                  <div style={styles.stepper}>
                    <button
                      style={{
                        ...styles.stepBtn,
                        opacity: n === 0 ? 0.35 : 1,
                      }}
                      onClick={() => changeQty(item.id, -1)}
                      disabled={n === 0}
                      aria-label={`Убрать ${item.name}`}
                    >
                      <Minus size={15} strokeWidth={3} />
                    </button>
                    <span style={styles.stepNum}>{n}</span>
                    <button
                      style={styles.stepBtn}
                      onClick={() => changeQty(item.id, 1)}
                      aria-label={`Добавить ${item.name}`}
                    >
                      <Plus size={15} strokeWidth={3} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        <div style={styles.pager}>
          <button
            style={{ ...styles.pagerBtn, opacity: page === 0 ? 0.3 : 1 }}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft size={22} />
          </button>
          <div style={styles.dots}>
            {Array.from({ length: pageCount }).map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                style={{
                  ...styles.dot,
                  ...(i === page ? styles.dotActive : {}),
                }}
                aria-label={`Страница ${i + 1}`}
              />
            ))}
          </div>
          <button
            style={{
              ...styles.pagerBtn,
              opacity: page === pageCount - 1 ? 0.3 : 1,
            }}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page === pageCount - 1}
          >
            <ChevronRight size={22} />
          </button>
        </div>
      </div>

      {/* Bottom confirm bar */}
      {addToOrderId ? (
        <div style={styles.addToOrderBanner}>
          <span>Добавление к заказу стола №{tableNumber}</span>
          <button
            style={styles.addToOrderCancelBtn}
            onClick={() => {
              setAddToOrderId(null);
              setQty({});
              setComments({});
            }}
          >
            Отменить
          </button>
        </div>
      ) : (
        isTableLocked && (
          <div style={styles.lockWarning}>
            Стол №{tableNumber} уже занят активным заказом
            {activeTableEntry?.waiter && activeTableEntry.waiter !== waiterName
              ? ` (${activeTableEntry.waiter})`
              : ""}{" "}
            — его нужно выполнить или отменить, чтобы оформить новый
          </div>
        )
      )}
      <div style={styles.footer}>
        <div style={styles.footerInfo}>
          <span style={styles.footerCount}>{totalCount} поз.</span>
          <span style={styles.footerSum}>{money(totalSum)} сом</span>
        </div>
        <button
          style={{
            ...styles.confirmBtn,
            ...(totalCount === 0 || isTableLocked
              ? styles.confirmBtnDisabled
              : {}),
          }}
          disabled={totalCount === 0 || isTableLocked}
          onClick={() => setShowSummary(true)}
        >
          {isTableLocked
            ? "Стол занят"
            : addToOrderId
            ? "Добавить к заказу"
            : "Подтвердить заказ"}
        </button>
      </div>

      {/* Comment modal */}
      {editingComment && (
        <div style={styles.modalOverlay} onClick={() => setEditingComment(null)}>
          <div style={styles.commentModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{editingComment.name}</span>
              <button
                style={styles.closeBtn}
                onClick={() => setEditingComment(null)}
              >
                <X size={20} />
              </button>
            </div>

            <div style={styles.quickRow}>
              {quickComments.map((q) => (
                <button
                  key={q}
                  style={{
                    ...styles.quickChip,
                    ...(commentDraft === q ? styles.quickChipActive : {}),
                  }}
                  onClick={() =>
                    setCommentDraft((prev) => (prev === q ? "" : q))
                  }
                >
                  {q}
                </button>
              ))}
            </div>

            <textarea
              style={styles.commentInput}
              placeholder="Например: без лука, отдельно от заказа..."
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              rows={3}
              autoFocus
            />

            <button style={styles.sendBtn} onClick={saveComment}>
              <Check size={18} strokeWidth={2.5} />
              Сохранить комментарий
            </button>
          </div>
        </div>
      )}

      {/* Orders modal: активные заказы + история выполненных */}
      {showOrders && (
        <div style={styles.modalOverlay} onClick={() => setShowOrders(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Заказы</span>
              <button
                style={styles.closeBtn}
                onClick={() => setShowOrders(false)}
              >
                <X size={20} />
              </button>
            </div>

            <div style={styles.ordersTabs}>
              <button
                style={{
                  ...styles.ordersTab,
                  ...(ordersTab === "active" ? styles.ordersTabActive : {}),
                }}
                onClick={() => setOrdersTab("active")}
              >
                Активные{activeOrders.length > 0 ? ` (${activeOrders.length})` : ""}
              </button>
              <button
                style={{
                  ...styles.ordersTab,
                  ...(ordersTab === "done" ? styles.ordersTabActive : {}),
                }}
                onClick={() => setOrdersTab("done")}
              >
                История
              </button>
            </div>

            {ordersLoading ? (
              <p style={styles.historyEmpty}>Загрузка...</p>
            ) : ordersTab === "active" ? (
              activeOrders.length === 0 ? (
                <p style={styles.historyEmpty}>
                  Активных заказов нет. Они появляются здесь после отправки
                  заказа и блокируют стол до выполнения.
                </p>
              ) : (
                <div style={styles.modalList}>
                  {activeOrders.map((entry) => {
                    const elapsed = getElapsedMinutes(entry.date);
                    const overdue = elapsed >= OVERDUE_MINUTES;
                    return (
                    <div
                      key={entry.id}
                      style={{
                        ...styles.historyRow,
                        ...(overdue ? styles.historyRowOverdue : {}),
                      }}
                    >
                      <button
                        style={styles.historyRowMain}
                        onClick={() => setViewingOrder(entry)}
                      >
                        <span style={styles.historyTable}>
                          Стол №{entry.table}
                          <span
                            style={{
                              ...styles.elapsedBadge,
                              ...(overdue ? styles.elapsedBadgeOverdue : {}),
                            }}
                          >
                            {formatElapsed(elapsed)}
                          </span>
                        </span>
                        <span style={styles.historyMeta}>
                          {formatDate(entry.date)} · {entry.itemsCount} поз. ·{" "}
                          {money(entry.total)} сом
                        </span>
                      </button>
                      <button
                        style={styles.eyeBtn}
                        onClick={() => setViewingOrder(entry)}
                        aria-label={`Состав заказа стола ${entry.table}`}
                      >
                        <Eye size={17} strokeWidth={2.2} />
                      </button>
                      <button
                        style={styles.addToOrderBtn}
                        onClick={() => startAddToOrder(entry)}
                        aria-label={`Добавить к заказу стола ${entry.table}`}
                      >
                        <Plus size={17} strokeWidth={2.4} />
                      </button>
                      <button
                        style={styles.completeBtn}
                        onClick={() => completeOrder(entry.id)}
                        aria-label={`Выполнить заказ стола ${entry.table}`}
                      >
                        <Check size={17} strokeWidth={2.4} />
                      </button>
                      <button
                        style={styles.historyDeleteBtn}
                        onClick={() => setConfirmingCancel(entry)}
                        aria-label={`Отменить заказ стола ${entry.table}`}
                      >
                        <Trash2 size={17} strokeWidth={2.2} />
                      </button>
                    </div>
                    );
                  })}
                </div>
              )
            ) : orderHistory.length === 0 ? (
              <p style={styles.historyEmpty}>
                Пока пусто. Заказы попадают сюда после выполнения.
              </p>
            ) : (
              <div style={styles.modalList}>
                {orderHistory.map((entry) => (
                  <div key={entry.id} style={styles.historyRow}>
                    <button
                      style={styles.historyRowMain}
                      onClick={() => setViewingOrder(entry)}
                    >
                      <span style={styles.historyTable}>
                        Стол №{entry.table}
                      </span>
                      <span style={styles.historyMeta}>
                        {formatDate(entry.completedDate || entry.date)} ·{" "}
                        {entry.itemsCount} поз. · {money(entry.total)} сом
                      </span>
                      {entry.waiter && (
                        <span style={styles.historyWaiter}>
                          {entry.waiter}
                        </span>
                      )}
                    </button>
                    <button
                      style={styles.eyeBtn}
                      onClick={() => setViewingOrder(entry)}
                      aria-label={`Состав заказа стола ${entry.table}`}
                    >
                      <Eye size={17} strokeWidth={2.2} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm cancel modal */}
      {confirmingCancel && (
        <div
          style={{ ...styles.modalOverlay, alignItems: "center" }}
          onClick={() => setConfirmingCancel(null)}
        >
          <div style={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.confirmIcon}>
              <Trash2 size={22} strokeWidth={2.2} />
            </div>
            <div style={styles.confirmTitle}>
              Отменить заказ стола №{confirmingCancel.table}?
            </div>
            <div style={styles.confirmText}>
              {confirmingCancel.itemsCount} поз. на{" "}
              {money(confirmingCancel.total)} сом будут удалены без выполнения.
              Это действие нельзя отменить.
            </div>
            <div style={styles.confirmActions}>
              <button
                style={styles.confirmCancelBtn}
                onClick={() => setConfirmingCancel(null)}
              >
                Оставить
              </button>
              <button
                style={styles.confirmDeleteBtn}
                onClick={() => {
                  cancelActiveOrder(confirmingCancel.id);
                  setConfirmingCancel(null);
                }}
              >
                Да, отменить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order detail modal — состав конкретного заказа */}
      {viewingOrder && (
        <div style={styles.modalOverlay} onClick={() => setViewingOrder(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.modalTitle}>
                  Стол №{viewingOrder.table}
                </div>
                <div style={styles.historyMeta}>
                  {formatDate(viewingOrder.completedDate || viewingOrder.date)}
                  {viewingOrder.waiter ? ` · ${viewingOrder.waiter}` : ""}
                </div>
              </div>
              <button
                style={styles.closeBtn}
                onClick={() => setViewingOrder(null)}
              >
                <X size={20} />
              </button>
            </div>

            <div style={styles.modalList}>
              {(() => {
                const orderItems = viewingOrder.items || [];
                const maxBatch = Math.max(
                  0,
                  ...orderItems.map((i) => i.batch || 0)
                );
                return orderItems.map((i, idx) => {
                  const isNew = maxBatch > 0 && (i.batch || 0) === maxBatch;
                  return (
                    <div key={`${i.id}-${idx}`} style={styles.modalRowWrap}>
                      <div style={styles.modalRow}>
                        <span style={styles.modalRowQty}>{i.n}×</span>
                        <span style={styles.modalRowName}>{i.name}</span>
                        {isNew && (
                          <span style={styles.newBadge}>Новое</span>
                        )}
                        <span style={styles.modalRowPrice}>
                          {money(i.price * i.n)} сом
                        </span>
                      </div>
                      {i.comment && (
                        <div style={styles.modalRowComment}>💬 {i.comment}</div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
            <div style={styles.modalTotal}>
              <span>Итого</span>
              <span>{money(viewingOrder.total)} сом</span>
            </div>
          </div>
        </div>
      )}

      {/* Summary modal */}
      {showSummary && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>
                {sent
                  ? addToOrderId
                    ? "Добавлено к заказу"
                    : "Заказ отправлен"
                  : addToOrderId
                  ? "Проверьте добавляемые позиции"
                  : "Проверьте заказ"}
              </span>
              <button
                style={styles.closeBtn}
                onClick={() => {
                  setShowSummary(false);
                  setSent(false);
                }}
              >
                <X size={20} />
              </button>
            </div>

            {!sent ? (
              <>
                <div style={styles.modalList}>
                  {selectedList.map((i) => (
                    <div key={i.id} style={styles.modalRowWrap}>
                      <div style={styles.modalRow}>
                        <span style={styles.modalRowQty}>{i.n}×</span>
                        <span style={styles.modalRowName}>{i.name}</span>
                        <span style={styles.modalRowPrice}>
                          {money(i.price * i.n)} сом
                        </span>
                      </div>
                      {comments[i.id] && (
                        <div style={styles.modalRowComment}>
                          💬 {comments[i.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div style={styles.modalTotal}>
                  <span>Итого</span>
                  <span>{money(totalSum)} сом</span>
                </div>
                <button
                  style={styles.sendBtn}
                  onClick={() => {
                    // batch — номер "захода": 0 у изначально отправленного заказа,
                    // растет с каждым довеском, чтобы отличать уже приготовленное от нового
                    const existing = addToOrderId
                      ? allActiveOrders.find((e) => e.id === addToOrderId)
                      : null;
                    const batch = existing
                      ? Math.max(0, ...existing.items.map((i) => i.batch || 0)) + 1
                      : 0;
                    const newItems = selectedList.map((i) => ({
                      id: i.id,
                      name: i.name,
                      price: i.price,
                      n: i.n,
                      comment: comments[i.id] || null,
                      batch,
                    }));
                    if (addToOrderId) {
                      appendToActiveOrder(
                        addToOrderId,
                        newItems,
                        totalCount,
                        totalSum
                      );
                    } else {
                      addActiveOrder({
                        id: `${Date.now()}`,
                        table: tableNumber,
                        date: new Date().toISOString(),
                        itemsCount: totalCount,
                        total: totalSum,
                        items: newItems,
                      });
                    }
                    setSent(true);
                  }}
                >
                  <Check size={18} strokeWidth={2.5} />
                  {addToOrderId ? "Добавить к заказу" : "Отправить на кухню/бар"}
                </button>
              </>
            ) : (
              <div style={styles.sentBox}>
                <div style={styles.sentIcon}>
                  <Check size={28} strokeWidth={3} />
                </div>
                <p style={styles.sentText}>
                  {addToOrderId
                    ? `Добавлено ${totalCount} позиций к заказу стола №${tableNumber}.`
                    : `Заказ на ${totalCount} позиций передан. Стол №${tableNumber}.`}
                </p>
                <button
                  style={styles.newOrderBtn}
                  onClick={() => {
                    setQty({});
                    setComments({});
                    setAddToOrderId(null);
                    setShowSummary(false);
                    setSent(false);
                  }}
                >
                  Новый заказ
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Обертка: настройка Supabase → выбор официанта → сам экран заказа --------

function SetupNotice() {
  return (
    <div style={wrapperStyles.center}>
      <div style={wrapperStyles.card}>
        <h2 style={wrapperStyles.title}>Нужно подключить базу данных</h2>
        <p style={wrapperStyles.text}>
          Эта версия сайта показывает историю заказов всем официантам, поэтому
          ей нужна общая база данных (Supabase — бесплатно). Создай проект на{" "}
          <strong>supabase.com</strong>, выполни SQL из README, а затем впиши
          его URL и ключ в файл <code>.env</code> (см. README.md в проекте) и
          пересобери сайт.
        </p>
      </div>
    </div>
  );
}

function WaiterPicker({ onPick, onSwitchCafe, onAdmin, restaurantName }) {
  const [custom, setCustom] = useState("");

  return (
    <div style={wrapperStyles.center}>
      <div style={wrapperStyles.card}>
        <h2 style={wrapperStyles.title}>Кто вы?</h2>
        <p style={wrapperStyles.text}>
          {restaurantName} · выберите свое имя — под ним будут видны только
          ваши активные заказы. Историю заказов видят все.
        </p>
        <div style={wrapperStyles.namesGrid}>
          {WAITER_NAMES.map((name) => (
            <button
              key={name}
              style={wrapperStyles.nameBtn}
              onClick={() => onPick(name)}
            >
              <User size={16} strokeWidth={2.2} />
              {name}
            </button>
          ))}
        </div>
        <div style={wrapperStyles.customRow}>
          <input
            style={wrapperStyles.customInput}
            placeholder="Или впишите свое имя"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            style={wrapperStyles.customBtn}
            disabled={!custom.trim()}
            onClick={() => onPick(custom.trim())}
          >
            Войти
          </button>
        </div>
        <button style={wrapperStyles.adminBtn} onClick={onAdmin}>
          <ShieldCheck size={15} strokeWidth={2.2} />
          Я администратор
        </button>
        <button style={wrapperStyles.linkBtn} onClick={onSwitchCafe}>
          Не то кафе? Сменить
        </button>
      </div>
    </div>
  );
}

function PinScreen({ onResolved }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!pin.trim()) return;
    setLoading(true);
    setError(null);
    const { restaurant, error: err } = await fetchRestaurantByPin(pin);
    setLoading(false);
    if (err) {
      setError(err);
      return;
    }
    onResolved(restaurant);
  };

  return (
    <div style={wrapperStyles.center}>
      <div style={wrapperStyles.card}>
        <h2 style={wrapperStyles.title}>Вход по PIN-коду</h2>
        <p style={wrapperStyles.text}>
          Введите PIN-код вашего заведения — его выдал администратор сайта.
          Дальше вход будет запоминаться на этом устройстве.
        </p>
        <input
          style={wrapperStyles.pinInput}
          type="text"
          autoFocus
          maxLength={5}
          placeholder="•••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\s/g, "").toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <p style={wrapperStyles.pinError}>{error}</p>}
        <button
          style={{
            ...wrapperStyles.customBtn,
            width: "100%",
            padding: "13px 0",
            opacity: loading || !pin.trim() ? 0.6 : 1,
          }}
          disabled={loading || !pin.trim()}
          onClick={submit}
        >
          {loading ? "Проверяем..." : "Войти"}
        </button>
      </div>
    </div>
  );
}

const WAITER_KEY = "waiter-current-name";

export default function App() {
  const [waiterName, setWaiterName] = useState(() => {
    try {
      return localStorage.getItem(WAITER_KEY) || null;
    } catch (e) {
      return null;
    }
  });

  // restaurant: null (ещё не знаем), undefined (загружается), объект (готово)
  const [restaurant, setRestaurant] = useState(undefined);

  // Выбор "Я администратор" происходит на том же экране, что и выбор
  // официанта (сразу при входе в заведение) — см. WaiterPicker.
  const [adminMode, setAdminMode] = useState(false);

  // Читаем PIN из ссылки один раз при создании компонента (а не заново внутри
  // эффекта) — иначе в дев-режиме React.StrictMode вызывает эффект дважды, и
  // первый же вызов стирает ?pin= из адресной строки до того, как второй
  // успеет его прочитать.
  const pinFromLinkRef = useRef(new URLSearchParams(window.location.search).get("pin"));

  // При открытии сайта — проверяем сначала ссылку с PIN (?pin=...), которую
  // выдаёт владельцу панель управления для быстрого входа без ручного набора,
  // а если её нет — привязано ли уже это устройство к кафе.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pinFromLink = pinFromLinkRef.current;
      if (pinFromLink) {
        // убираем PIN из адресной строки, чтобы не остался в истории/закладках
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
        const { restaurant: found, error } = await fetchRestaurantByPin(pinFromLink);
        if (cancelled) return;
        if (!error && found) {
          setCachedRestaurantId(found.id);
          setRestaurant(found);
          return;
        }
      }

      const cachedId = getCachedRestaurantId();
      if (!cachedId) {
        if (!cancelled) setRestaurant(null);
        return;
      }
      const { restaurant: found, error } = await fetchRestaurantById(cachedId);
      if (cancelled) return;
      if (error || !found) {
        // кафе удалили или id больше не существует — просим войти заново
        setCachedRestaurantId(null);
        setRestaurant(null);
      } else {
        setRestaurant(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPinResolved = (found) => {
    setCachedRestaurantId(found.id);
    setRestaurant(found);
  };

  // Пока официант работает — периодически подтягиваем актуальное меню/статус
  // кафе из базы. Так правки, сделанные владельцем/админом (меню, стоп-лист,
  // включение/отключение), доходят до официанта сами, без перезахода на сайт.
  const restaurantId = restaurant?.id;
  useEffect(() => {
    if (!restaurantId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const { restaurant: found, error } = await fetchRestaurantById(restaurantId);
      if (cancelled || error || !found) return;
      setRestaurant((r) => (r ? { ...r, ...found } : r));
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [restaurantId]);

  useEffect(() => {
    if (restaurant && restaurant.name) {
      document.title = `Меню официанта — ${restaurant.name}`;
    }
  }, [restaurant]);

  const switchCafe = () => {
    setCachedRestaurantId(null);
    setRestaurant(null);
    setWaiterName(null);
    try {
      localStorage.removeItem(WAITER_KEY);
    } catch (e) {
      // ничего страшного
    }
  };

  const pickWaiter = (name) => {
    try {
      localStorage.setItem(WAITER_KEY, name);
    } catch (e) {
      console.error("Не удалось сохранить имя официанта", e);
    }
    setWaiterName(name);
  };

  const switchWaiter = () => {
    try {
      localStorage.removeItem(WAITER_KEY);
    } catch (e) {
      // ничего страшного
    }
    setWaiterName(null);
  };

  if (!isSupabaseConfigured) return <SetupNotice />;
  if (restaurant === undefined) return null; // проверяем кэш — доля секунды
  if (restaurant === null) return <PinScreen onResolved={onPinResolved} />;
  if (adminMode)
    return (
      <AdminMenuGate
        restaurantId={restaurant.id}
        restaurantName={restaurant.name}
        restaurantPin={restaurant.pin}
        menu={restaurant.menu || { categories: [], items: [] }}
        onExit={() => setAdminMode(false)}
        onMenuUpdated={(menu) => setRestaurant((r) => ({ ...r, menu }))}
      />
    );
  if (!waiterName)
    return (
      <WaiterPicker
        onPick={pickWaiter}
        onSwitchCafe={switchCafe}
        onAdmin={() => setAdminMode(true)}
        restaurantName={restaurant.name}
      />
    );
  return (
    <OrderScreen
      waiterName={waiterName}
      onSwitchWaiter={switchWaiter}
      restaurantId={restaurant.id}
      restaurantName={restaurant.name}
      categories={restaurant.menu?.categories || []}
      items={restaurant.menu?.items || []}
    />
  );
}

const wrapperStyles = {
  center: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1B1918",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    background: "#242120",
    border: "1px solid #3a3532",
    borderRadius: 16,
    padding: "26px 22px",
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  title: {
    fontSize: 19,
    fontWeight: 700,
    color: "#F4EFE6",
    margin: "0 0 8px",
  },
  text: {
    fontSize: 13.5,
    color: "#9a938d",
    lineHeight: 1.5,
    margin: "0 0 20px",
  },
  namesGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 16,
  },
  nameBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    padding: "13px 0",
    borderRadius: 10,
    border: "1px solid #3a3532",
    background: "#1B1918",
    color: "#F4EFE6",
    fontSize: 14.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  customRow: {
    display: "flex",
    gap: 8,
  },
  customInput: {
    flex: 1,
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "11px 12px",
    color: "#F4EFE6",
    fontSize: 14,
    boxSizing: "border-box",
  },
  customBtn: {
    padding: "0 18px",
    borderRadius: 10,
    border: "none",
    background: "#8C2F2A",
    color: "#F4EFE6",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  pinInput: {
    width: "100%",
    boxSizing: "border-box",
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "14px 12px",
    color: "#F4EFE6",
    fontSize: 22,
    letterSpacing: "0.3em",
    textAlign: "center",
    marginBottom: 12,
  },
  pinError: {
    color: "#e07a72",
    fontSize: 13,
    marginTop: -4,
    marginBottom: 14,
  },
  linkBtn: {
    display: "block",
    width: "100%",
    marginTop: 14,
    background: "none",
    border: "none",
    color: "#8a8480",
    fontSize: 12.5,
    textDecoration: "underline",
    cursor: "pointer",
    textAlign: "center",
  },
  adminBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    marginTop: 14,
    padding: "10px 0",
    borderRadius: 10,
    border: "1px dashed #3a3532",
    background: "none",
    color: "#9a938d",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};

// --- Стили экрана заказа ------------------------------------------------

const WINE = "#8C2F2A";
const GOLD = "#C9982E";
const INK = "#1B1918";
const PANEL = "#242120";
const PAPER = "#F4EFE6";

const styles = {
  app: {
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: INK,
    color: PAPER,
    height: "100vh",
    maxWidth: 480,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
    padding: "10px 14px 0",
    borderBottom: `1px solid #35312e`,
  },
  restaurantLabel: {
    fontSize: 13,
    fontWeight: 700,
    color: PAPER,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  headerTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  tableStepper: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: PANEL,
    borderRadius: 10,
    border: "1px solid #3a3532",
    padding: "3px 5px",
  },
  tableStepperLocked: {
    border: "1px solid #b3564f",
    background: "rgba(179,86,79,0.12)",
  },
  tableNumLocked: {
    color: "#e07a72",
  },
  lockWarning: {
    flexShrink: 0,
    fontSize: 12.5,
    color: "#e07a72",
    background: "rgba(179,86,79,0.12)",
    borderTop: "1px solid #3a3532",
    padding: "8px 16px",
    textAlign: "center",
  },
  addToOrderBanner: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontSize: 12.5,
    fontWeight: 600,
    color: GOLD,
    background: "rgba(201,166,90,0.12)",
    borderTop: "1px solid #3a3532",
    padding: "8px 16px",
    textAlign: "center",
  },
  addToOrderCancelBtn: {
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#c9c4bf",
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
  },
  waiterRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
  },
  waiterBadge: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11.5,
    fontWeight: 600,
    color: "#c9c4bf",
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 20,
    padding: "3px 8px",
  },
  waiterRowRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  syncWarning: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "#e07a72",
  },
  switchWaiterBtn: {
    display: "flex",
    alignItems: "center",
    color: "#8a8480",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 2,
  },
  historyBtn: {
    position: "relative",
    width: 34,
    height: 34,
    borderRadius: 9,
    border: "1px solid #3a3532",
    background: PANEL,
    color: "#c9c4bf",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  historyBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    minWidth: 16,
    height: 16,
    padding: "0 3px",
    borderRadius: 8,
    background: WINE,
    color: PAPER,
    fontSize: 10,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  searchBtnActive: {
    borderColor: GOLD,
    color: GOLD,
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 9,
    padding: "6px 10px",
  },
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: PAPER,
    fontSize: 13.5,
  },
  searchCloseBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "#8a8480",
    cursor: "pointer",
    padding: 2,
  },
  ordersTabs: {
    display: "flex",
    gap: 8,
    marginBottom: 14,
  },
  ordersTab: {
    flex: 1,
    padding: "9px 0",
    borderRadius: 8,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#9a938d",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  ordersTabActive: {
    background: WINE,
    borderColor: WINE,
    color: PAPER,
  },
  completeBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid #3a3532",
    background: "transparent",
    color: GOLD,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  addToOrderBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#9a938d",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  historyEmpty: {
    fontSize: 14,
    color: "#8a8480",
    textAlign: "center",
    padding: "20px 4px 8px",
  },
  historyRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderBottom: "1px solid #35312e",
    paddingBottom: 10,
  },
  historyRowOverdue: {
    background: "rgba(179,86,79,0.12)",
    borderBottom: "1px solid rgba(179,86,79,0.4)",
    borderRadius: 8,
    padding: "6px 6px 10px",
    margin: "0 -6px",
  },
  historyRowMain: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    background: "none",
    border: "none",
    padding: 0,
    textAlign: "left",
    cursor: "pointer",
  },
  historyTable: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 700,
    color: PAPER,
  },
  elapsedBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "#9a938d",
    background: "#1B1918",
    borderRadius: 20,
    padding: "2px 8px",
  },
  elapsedBadgeOverdue: {
    color: "#e07a72",
    background: "rgba(179,86,79,0.18)",
  },
  historyMeta: {
    fontSize: 12.5,
    color: "#8a8480",
  },
  historyWaiter: {
    fontSize: 11.5,
    color: GOLD,
    fontWeight: 600,
    marginTop: 2,
  },
  historyDeleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#b3564f",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  eyeBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#9a938d",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  confirmModal: {
    width: "100%",
    maxWidth: 400,
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
  confirmTitle: {
    fontSize: 16.5,
    fontWeight: 700,
    color: PAPER,
    marginBottom: 8,
  },
  confirmText: {
    fontSize: 13.5,
    color: "#9a938d",
    lineHeight: 1.4,
    marginBottom: 20,
  },
  confirmActions: {
    display: "flex",
    gap: 10,
  },
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
  tableLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.12em",
    color: "#8a8480",
    marginRight: 2,
  },
  tableBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    border: "none",
    background: "#33302d",
    color: PAPER,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  tableNum: {
    fontSize: 14,
    fontWeight: 700,
    color: GOLD,
    minWidth: 28,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
  pageIndicator: {
    fontSize: 12,
    color: "#8a8480",
    fontVariantNumeric: "tabular-nums",
  },
  tabs: {
    display: "flex",
    gap: 6,
    paddingBottom: 10,
    overflowX: "auto",
    overflowY: "hidden",
    WebkitOverflowScrolling: "touch",
  },
  tab: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#9a938d",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  tabActive: {
    background: WINE,
    borderColor: WINE,
    color: PAPER,
  },
  gridWrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    padding: "14px 16px 0",
    overflow: "hidden",
  },
  grid: {
    display: "grid",
    gap: GRID_GAP,
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    alignContent: "start",
  },
  card: {
    background: PANEL,
    border: "1px solid #35312e",
    borderRadius: 10,
    padding: "8px 9px 7px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    height: CARD_H,
    boxSizing: "border-box",
    overflow: "hidden",
  },
  cardActive: {
    borderColor: GOLD,
    boxShadow: `0 0 0 1px ${GOLD} inset`,
  },
  cardStopped: {
    opacity: 0.5,
  },
  stoppedBadge: {
    textAlign: "center",
    background: "rgba(224,122,114,0.15)",
    color: "#e07a72",
    fontSize: 11.5,
    fontWeight: 700,
    borderRadius: 8,
    padding: "6px 0",
  },
  cardTop: {
    marginBottom: 4,
  },
  cardNameRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 4,
    marginBottom: 2,
  },
  cardName: {
    fontSize: 12.5,
    fontWeight: 600,
    lineHeight: 1.2,
    color: PAPER,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  commentBtn: {
    flexShrink: 0,
    width: 20,
    height: 20,
    borderRadius: 5,
    border: "none",
    background: "transparent",
    color: "#6f6a65",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  commentBtnActive: {
    color: GOLD,
  },
  cardComment: {
    fontSize: 10.5,
    color: GOLD,
    fontStyle: "italic",
    marginBottom: 3,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardPrice: {
    fontSize: 12.5,
    color: GOLD,
    fontWeight: 700,
  },
  alreadyOrderedBadge: {
    display: "inline-block",
    marginLeft: 6,
    fontSize: 10,
    fontWeight: 700,
    color: "#7fae7a",
    background: "rgba(127,174,122,0.15)",
    borderRadius: 20,
    padding: "1px 6px",
    whiteSpace: "nowrap",
  },
  stepper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#1B1918",
    borderRadius: 7,
    padding: "3px 5px",
  },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "none",
    background: "#33302d",
    color: PAPER,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  stepNum: {
    fontSize: 15,
    fontWeight: 700,
    minWidth: 20,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
  pager: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: "14px 0",
  },
  pagerBtn: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "1px solid #3a3532",
    background: PANEL,
    color: PAPER,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  dots: {
    display: "flex",
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    border: "none",
    background: "#4a453f",
    cursor: "pointer",
    padding: 0,
  },
  dotActive: {
    background: GOLD,
    width: 18,
    borderRadius: 4,
  },
  footer: {
    flexShrink: 0,
    background: PANEL,
    borderTop: "1px solid #3a3532",
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 -4px 12px rgba(0,0,0,0.18)",
  },
  footerInfo: {
    display: "flex",
    flexDirection: "column",
    minWidth: 82,
  },
  footerCount: {
    fontSize: 12,
    color: "#9a938d",
  },
  footerSum: {
    fontSize: 19,
    fontWeight: 700,
    color: GOLD,
  },
  confirmBtn: {
    flex: 1,
    padding: "16px 0",
    borderRadius: 12,
    border: "none",
    background: WINE,
    color: PAPER,
    fontSize: 16.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  confirmBtnDisabled: {
    background: "#3a3532",
    color: "#77726c",
    cursor: "not-allowed",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 20,
  },
  modal: {
    width: "100%",
    maxWidth: 480,
    background: PANEL,
    borderRadius: "18px 18px 0 0",
    padding: "18px 18px 26px",
    maxHeight: "82vh",
    display: "flex",
    flexDirection: "column",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: PAPER,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#9a938d",
    cursor: "pointer",
    padding: 4,
  },
  modalList: {
    overflowY: "auto",
    marginBottom: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  modalRowWrap: {
    borderBottom: "1px solid #35312e",
    paddingBottom: 8,
  },
  modalRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 14.5,
  },
  modalRowComment: {
    fontSize: 12.5,
    color: GOLD,
    fontStyle: "italic",
    marginTop: 3,
  },
  newBadge: {
    fontSize: 10.5,
    fontWeight: 700,
    color: GOLD,
    background: "rgba(201,166,90,0.15)",
    borderRadius: 20,
    padding: "2px 7px",
  },
  commentModal: {
    width: "100%",
    maxWidth: 480,
    background: PANEL,
    borderRadius: "18px 18px 0 0",
    padding: "18px 18px 26px",
  },
  quickRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  quickChip: {
    padding: "8px 12px",
    borderRadius: 20,
    border: "1px solid #3a3532",
    background: "transparent",
    color: "#c9c4bf",
    fontSize: 13,
    cursor: "pointer",
  },
  quickChipActive: {
    background: GOLD,
    borderColor: GOLD,
    color: INK,
    fontWeight: 700,
  },
  commentInput: {
    width: "100%",
    background: "#1B1918",
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "12px",
    color: PAPER,
    fontSize: 14.5,
    fontFamily: "inherit",
    resize: "none",
    marginBottom: 14,
    boxSizing: "border-box",
  },
  modalRowQty: {
    color: GOLD,
    fontWeight: 700,
    minWidth: 26,
  },
  modalRowName: {
    flex: 1,
    color: PAPER,
  },
  modalRowPrice: {
    color: "#9a938d",
    fontVariantNumeric: "tabular-nums",
  },
  modalTotal: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 16,
    fontWeight: 700,
    color: PAPER,
    padding: "8px 0 16px",
  },
  sendBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "15px 0",
    borderRadius: 10,
    border: "none",
    background: GOLD,
    color: INK,
    fontSize: 15.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  sentBox: {
    textAlign: "center",
    padding: "10px 0 6px",
  },
  sentIcon: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: GOLD,
    color: INK,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 16px",
  },
  sentText: {
    fontSize: 15,
    color: PAPER,
    marginBottom: 18,
  },
  newOrderBtn: {
    width: "100%",
    padding: "14px 0",
    borderRadius: 10,
    border: "none",
    background: WINE,
    color: PAPER,
    fontSize: 15.5,
    fontWeight: 700,
    cursor: "pointer",
  },
};
