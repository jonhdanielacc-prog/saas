import React, { useState } from "react";
import { Lock } from "lucide-react";
import AdminScreen from "./AdminScreen";

const WINE = "#8C2F2A";
const GOLD = "#C9982E";
const INK = "#1B1918";
const PANEL = "#242120";
const PAPER = "#F4EFE6";

// Вход в администрирование КОНКРЕТНОГО кафе — в отличие от обычного входа
// официанта, этот PIN не запоминается: спрашивается заново при каждой
// попытке зайти (см. CLAUDE.md). После входа — экран администратора
// (AdminScreen): мониторинг заказов, стоп-лист, статистика, меню.
export default function AdminMenuGate({ restaurantId, restaurantName, restaurantPin, menu, trialInfo, onExit, onMenuUpdated }) {
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(null);

  if (!unlocked) {
    const submit = () => {
      if (pin.trim().toUpperCase() === String(restaurantPin || "").trim().toUpperCase()) {
        setUnlocked(true);
        setPinError(null);
      } else {
        setPinError("Неверный PIN-код.");
      }
    };

    return (
      <div style={styles.overlay} onClick={onExit}>
        <div style={styles.gateCard} onClick={(e) => e.stopPropagation()}>
          <div style={styles.lockIcon}>
            <Lock size={20} strokeWidth={2.2} />
          </div>
          <h2 style={styles.gateTitle}>Вход администратора</h2>
          <p style={styles.gateText}>
            Введите PIN-код заведения ещё раз — вход администратора не
            запоминается, в отличие от обычного входа официанта.
          </p>
          <input
            style={styles.gateInput}
            type="text"
            autoFocus
            maxLength={5}
            placeholder="•••••"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\s/g, "").toUpperCase());
              setPinError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {pinError && <p style={styles.gateError}>{pinError}</p>}
          <button style={styles.gateBtn} onClick={submit}>
            Войти
          </button>
          <button style={styles.gateCancelBtn} onClick={onExit}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  return (
    <AdminScreen
      restaurantId={restaurantId}
      restaurantName={restaurantName}
      restaurantPin={restaurantPin}
      menu={menu}
      trialInfo={trialInfo}
      onExit={onExit}
      onMenuUpdated={onMenuUpdated}
    />
  );
}

const styles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  gateCard: {
    width: "100%",
    maxWidth: 360,
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 16,
    padding: "26px 22px",
    textAlign: "center",
    margin: "0 16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  lockIcon: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "rgba(201,152,46,0.15)",
    color: GOLD,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  },
  gateTitle: { fontSize: 17, fontWeight: 700, color: PAPER, margin: "0 0 8px" },
  gateText: { fontSize: 13, color: "#9a938d", lineHeight: 1.5, margin: "0 0 18px" },
  gateInput: {
    width: "100%",
    boxSizing: "border-box",
    background: INK,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "14px 12px",
    color: PAPER,
    fontSize: 22,
    letterSpacing: "0.3em",
    textAlign: "center",
    marginBottom: 10,
  },
  gateError: { color: "#e07a72", fontSize: 12.5, marginTop: -4, marginBottom: 10 },
  gateBtn: {
    width: "100%",
    padding: "12px 0",
    borderRadius: 10,
    border: "none",
    background: WINE,
    color: PAPER,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginBottom: 8,
  },
  gateCancelBtn: {
    width: "100%",
    padding: "10px 0",
    borderRadius: 10,
    border: "none",
    background: "none",
    color: "#8a8480",
    fontSize: 13,
    cursor: "pointer",
  },
};
