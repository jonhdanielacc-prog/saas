import React, { useState } from "react";
import { Lock } from "lucide-react";
import {
  isOwnerPasswordConfigured,
  isOwnerUnlocked,
  tryUnlockOwner,
  lockOwner,
} from "./ownerAuth";
import OwnerDashboard from "./OwnerDashboard";

const INK = "#1B1918";
const PANEL = "#242120";
const PAPER = "#F4EFE6";
const WINE = "#8C2F2A";

export default function OwnerGate() {
  const [unlocked, setUnlocked] = useState(isOwnerUnlocked());
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  if (!isOwnerPasswordConfigured()) {
    return (
      <div className="app-shell-min" style={styles.center}>
        <div style={styles.card}>
          <h2 style={styles.title}>Панель не настроена</h2>
          <p style={styles.text}>
            Не задан пароль владельца. Добавь переменную окружения{" "}
            <code>VITE_OWNER_PASSWORD</code> при сборке сайта (см. README) и
            пересобери проект.
          </p>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    const submit = () => {
      if (tryUnlockOwner(password)) {
        setUnlocked(true);
        setError(null);
      } else {
        setError("Неверный пароль.");
      }
    };

    return (
      <div className="app-shell-min" style={styles.center}>
        <div style={styles.card}>
          <div style={styles.lockIcon}>
            <Lock size={20} strokeWidth={2.2} />
          </div>
          <h2 style={styles.title}>Панель владельца</h2>
          <p style={styles.text}>
            Здесь управление всеми кафе — введите пароль, чтобы продолжить.
          </p>
          <input
            style={styles.input}
            type="password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Пароль"
          />
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.btn} onClick={submit}>
            Войти
          </button>
        </div>
      </div>
    );
  }

  return (
    <OwnerDashboard
      onLock={() => {
        lockOwner();
        setUnlocked(false);
        setPassword("");
      }}
    />
  );
}

const styles = {
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: INK,
    padding: 20,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 360,
    background: PANEL,
    border: "1px solid #3a3532",
    borderRadius: 16,
    padding: "26px 22px",
    textAlign: "center",
  },
  lockIcon: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "rgba(201,152,46,0.15)",
    color: "#C9982E",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  },
  title: { fontSize: 17, fontWeight: 700, color: PAPER, margin: "0 0 8px" },
  text: { fontSize: 13, color: "#9a938d", lineHeight: 1.5, margin: "0 0 18px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: INK,
    border: "1px solid #3a3532",
    borderRadius: 10,
    padding: "12px",
    color: PAPER,
    fontSize: 15,
    textAlign: "center",
    marginBottom: 10,
  },
  error: { color: "#e07a72", fontSize: 12.5, marginTop: -4, marginBottom: 10 },
  btn: {
    width: "100%",
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
