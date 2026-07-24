import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import OwnerGate from "./OwnerGate.jsx";
import "./index.css";

document.title = "OrderBoard";

// Простая маршрутизация без библиотек: обычный сайт для официантов живёт на
// корне, а панель владельца — по адресу с хэшем #owner (например,
// https://твой-сайт/#owner). Такой подход не требует настройки серверных
// перенаправлений на GitHub Pages.
//
// Переход между # / и #owner меняет только фрагмент URL — браузер в этом
// случае не делает полную перезагрузку страницы (это "навигация в пределах
// документа"), поэтому слушаем hashchange и перерисовываем дерево сами.
const root = ReactDOM.createRoot(document.getElementById("root"));

function render() {
  const isOwnerRoute = window.location.hash === "#owner";
  root.render(
    <React.StrictMode>
      {isOwnerRoute ? <OwnerGate /> : <App />}
    </React.StrictMode>
  );
}

window.addEventListener("hashchange", render);
render();
