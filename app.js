// ==========================
// CONFIG
// ==========================
const SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";

// ==========================
// HELPERS
// ==========================
const fmt = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 });
const money = (n) => `₨ ${fmt.format(Number(n || 0))}`;

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  // Keep local date accurate
  const local = new Date(d.getTime() - off * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function parseAmount(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function showToast(msg, type = "success") {
  const area = document.getElementById("toastArea");
  const id = `t_${Date.now()}`;

  area.innerHTML = `
    <div class="toast align-items-center text-bg-${type} border-0 show mb-2" id="${id}" role="alert">
      <div class="d-flex">
        <div class="toast-body">
          ${msg}
        </div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="Close"></button>
      </div>
    </div>
  ` + area.innerHTML;

  const toastEl = document.getElementById(id);
  toastEl.querySelector(".btn-close").addEventListener("click", () => toastEl.remove());
  setTimeout(() => toastEl.remove(), 3500);
}

function startOfWeek(d) {
  // Monday as start
  const dt = new Date(d);
  const day = dt.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0,0,0,0);
  return dt;
}

function startOfMonth(d) {
  const dt = new Date(d);
  dt.setDate(1);
  dt.setHours(0,0,0,0);
  return dt;
}

function dateOnly(dateStr) {
  // Accept yyyy-mm-dd and return Date at local midnight
  const [y,m,dd] = String(dateStr).split("-").map(Number);
  const dt = new Date(y, m - 1, dd);
  dt.setHours(0,0,0,0);
  return dt;
}

// ==========================
// STATE
// ==========================
let allTx = [];
let activeFilter = "daily"; // daily|weekly|monthly
let chart;

// ==========================
// DOM
// ==========================
const el = (id) => document.getElementById(id);

const form = el("txnForm");
const dateInput = el("date");
const typeSelect = el("type");
const categorySelect = el("category");
const amountInput = el("amount");
const accountSelect = el("account");
const noteInput = el("note");

const singleAccountWrap = el("singleAccountWrap");
const transferWrap = el("transferWrap");
const fromAccount = el("fromAccount");
const toAccount = el("toAccount");

const refreshBtn = el("refreshBtn");
const exportPdfBtn = el("exportPdfBtn");

// Dashboard fields
const todayIncomeEl = el("todayIncome");
const todayExpenseEl = el("todayExpense");
const monthIncomeEl = el("monthIncome");
const monthExpenseEl = el("monthExpense");
const cashBalEl = el("cashBal");
const jazzBalEl = el("jazzBal");
const totalBalEl = el("totalBal");
const netPillEl = el("netPill");
const txTableBody = el("txTableBody");
const activeFilterLabel = el("activeFilterLabel");

// ==========================
// UI: Type toggle
// ==========================
function updateTypeUI() {
  const t = typeSelect.value;
  if (t === "Transfer") {
    singleAccountWrap.classList.add("d-none");
    transferWrap.classList.remove("d-none");
    // Not required by HTML5 anymore since wrapped; validate manually
  } else {
    transferWrap.classList.add("d-none");
    singleAccountWrap.classList.remove("d-none");
  }
}

// ==========================
// BACKEND CALLS
// ==========================
async function fetchTransactions() {
  const res = await fetch(SCRIPT_URL, { method: "GET" });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Failed to load data");
  return data.data || [];
}

async function saveTransaction(payload) {
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // Apps Script friendly
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Failed to save");
  return data;
}

// ==========================
// COMPUTATIONS
// ==========================
function normalizeTx(row) {
  // Apps Script returns headers as keys
  // Timestamp can be Date object string; keep as is
  return {
    date: String(row["Date"] || "").slice(0, 10),
    type: String(row["Type"] || ""),
    category: String(row["Category"] || ""),
    amount: parseAmount(row["Amount"]),
    fromAccount: String(row["FromAccount"] || ""),
    toAccount: String(row["ToAccount"] || ""),
    note: String(row["Note"] || "")
  };
}

function getRangeForFilter(filter) {
  const now = new Date();
  now.setHours(0,0,0,0);

  if (filter === "daily") {
    return { start: new Date(now), end: new Date(now.getTime() + 86400000) }; // [start, end)
  }
  if (filter === "weekly") {
    const start = startOfWeek(now);
    const end = new Date(start.getTime() + 7 * 86400000);
    return { start, end };
  }
  // monthly
  const start = startOfMonth(now);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  end.setHours(0,0,0,0);
  return { start, end };
}

function inRange(tx, range) {
  if (!tx.date) return false;
  const d = dateOnly(tx.date);
  return d >= range.start && d < range.end;
}

function calcBalances(transactions) {
  // Start at 0 balances; compute based on allTx
  let cash = 0;
  let jazz = 0;

  for (const tx of transactions) {
    const amt = tx.amount || 0;
    if (tx.type === "Income") {
      if (tx.fromAccount === "Cash") cash += amt;
      if (tx.fromAccount === "JazzCash") jazz += amt;
    } else if (tx.type === "Expense") {
      if (tx.fromAccount === "Cash") cash -= amt;
      if (tx.fromAccount === "JazzCash") jazz -= amt;
    } else if (tx.type === "Transfer") {
      // Move from -> to
      if (tx.fromAccount === "Cash") cash -= amt;
      if (tx.fromAccount === "JazzCash") jazz -= amt;
      if (tx.toAccount === "Cash") cash += amt;
      if (tx.toAccount === "JazzCash") jazz += amt;
    }
  }

  return { cash, jazz, total: cash + jazz };
}

function sumByType(transactions, type) {
  return transactions
    .filter(t => t.type === type)
    .reduce((a, b) => a + (b.amount || 0), 0);
}

function computeDashboard() {
  const now = new Date();
  now.setHours(0,0,0,0);

  const todayRange = getRangeForFilter("daily");
  const monthRange = getRangeForFilter("monthly");
  const activeRange = getRangeForFilter(activeFilter);

  const todayTx = allTx.filter(t => inRange(t, todayRange));
  const monthTx = allTx.filter(t => inRange(t, monthRange));
  const filteredTx = allTx.filter(t => inRange(t, activeRange));

  // Today & Monthly sums (ignore transfers)
  const todayIncome = sumByType(todayTx, "Income");
  const todayExpense = sumByType(todayTx, "Expense");
  const monthIncome = sumByType(monthTx, "Income");
  const monthExpense = sumByType(monthTx, "Expense");

  // Balances from all transactions (not filtered)
  const { cash, jazz, total } = calcBalances(allTx);

  // Render
  todayIncomeEl.textContent = money(todayIncome);
  todayExpenseEl.textContent = money(todayExpense);
  monthIncomeEl.textContent = money(monthIncome);
  monthExpenseEl.textContent = money(monthExpense);

  cashBalEl.textContent = money(cash);
  jazzBalEl.textContent = money(jazz);
  totalBalEl.textContent = money(total);

  const net = monthIncome - monthExpense;
  netPillEl.textContent = `Net: ${money(net)}`;

  // Table + Chart based on active filter
  renderTable(filteredTx);
  renderChart(filteredTx);
}

function renderTable(txList) {
  const items = [...txList].sort((a,b) => (b.date || "").localeCompare(a.date || "")).slice(0, 12);

  if (!items.length) {
    txTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No transactions in this range.</td></tr>`;
    return;
  }

  txTableBody.innerHTML = items.map(tx => {
    const badge = tx.type === "Income"
      ? `<span class="badge bg-success-subtle text-success border border-success-subtle">Income</span>`
      : tx.type === "Expense"
        ? `<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Expense</span>`
        : `<span class="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle">Transfer</span>`;

    const acc = tx.type === "Transfer"
      ? `${tx.fromAccount} <i class="bi bi-arrow-right-short"></i> ${tx.toAccount}`
      : `${tx.fromAccount}`;

    return `
      <tr>
        <td class="fw-semibold">${tx.date || "-"}</td>
        <td>${badge}</td>
        <td>${tx.category || "-"}</td>
        <td class="text-end fw-bold">${money(tx.amount)}</td>
        <td>${acc || "-"}</td>
        <td class="text-muted small">${(tx.note || "").slice(0, 40)}</td>
      </tr>
    `;
  }).join("");
}

function renderChart(txList) {
  // Aggregate sums for the active filter range: Income vs Expense
  const income = sumByType(txList, "Income");
  const expense = sumByType(txList, "Expense");

  const ctx = document.getElementById("incomeExpenseChart");
  const data = {
    labels: ["Income", "Expense"],
    datasets: [{
      label: "Amount",
      data: [income, expense],
      borderWidth: 1
    }]
  };

  if (chart) {
    chart.data = data;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${money(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        y: {
          ticks: {
            callback: (v) => money(v).replace("₨ ", "")
          }
        }
      }
    }
  });
}

// ==========================
// PDF EXPORT
// ==========================
function exportPDF() {
  const range = getRangeForFilter(activeFilter);
  const txList = allTx.filter(t => inRange(t, range)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));

  const income = sumByType(txList, "Income");
  const expense = sumByType(txList, "Expense");
  const { cash, jazz, total } = calcBalances(allTx);

  const label = activeFilter.toUpperCase();
  const title = `FinTrack Report (${label})`;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(title, 14, 16);

  doc.setFontSize(11);
  doc.text(`Range: ${range.start.toISOString().slice(0,10)} to ${new Date(range.end.getTime()-1).toISOString().slice(0,10)}`, 14, 24);

  doc.setFontSize(12);
  doc.text(`Income: ${money(income)}    Expense: ${money(expense)}    Net: ${money(income-expense)}`, 14, 34);

  doc.setFontSize(11);
  doc.text(`Balances (All-time): Cash ${money(cash)} | JazzCash ${money(jazz)} | Total ${money(total)}`, 14, 42);

  const rows = txList.map(t => ([
    t.date || "",
    t.type || "",
    t.category || "",
    String(t.amount || 0),
    t.type === "Transfer" ? `${t.fromAccount} -> ${t.toAccount}` : (t.fromAccount || ""),
    (t.note || "")
  ]));

  doc.autoTable({
    startY: 48,
    head: [["Date", "Type", "Category", "Amount", "Account(s)", "Note"]],
    body: rows,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [22, 163, 74] },
    columnStyles: { 3: { halign: "right" } }
  });

  doc.save(`FinTrack-${activeFilter}-${todayISO()}.pdf`);
}

// ==========================
// INIT + EVENTS
// ==========================
async function loadAndRender() {
  try {
    refreshBtn.disabled = true;
    const rows = await fetchTransactions();
    allTx = rows.map(normalizeTx).filter(t => t.date && t.type && t.amount);

    computeDashboard();
    showToast("Dashboard updated.", "success");
  } catch (e) {
    console.error(e);
    showToast(e.message || "Failed to refresh data.", "danger");
  } finally {
    refreshBtn.disabled = false;
  }
}

document.querySelectorAll("[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.getAttribute("data-filter");
    activeFilterLabel.textContent = activeFilter[0].toUpperCase() + activeFilter.slice(1);
    computeDashboard();
  });
});

typeSelect.addEventListener("change", updateTypeUI);

refreshBtn.addEventListener("click", loadAndRender);

exportPdfBtn.addEventListener("click", exportPDF);

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Bootstrap validation
  if (!form.checkValidity()) {
    form.classList.add("was-validated");
    return;
  }

  const t = typeSelect.value;
  const date = dateInput.value;
  const category = categorySelect.value;
  const amount = parseAmount(amountInput.value);
  const note = noteInput.value.trim();

  let payload = {
    date,
    type: t,
    category,
    amount,
    note
  };

  if (t === "Transfer") {
    const f = fromAccount.value;
    const to = toAccount.value;
    if (f === to) {
      showToast("From and To accounts must be different for transfer.", "danger");
      return;
    }
    payload.fromAccount = f;
    payload.toAccount = to;
  } else {
    payload.fromAccount = accountSelect.value; // store in FromAccount
    payload.toAccount = ""; // not used
  }

  try {
    const btn = document.getElementById("submitBtn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Saving...`;

    await saveTransaction(payload);

    // Reset amount/note only (keep date/type/category to speed entry)
    amountInput.value = "";
    noteInput.value = "";
    form.classList.remove("was-validated");

    showToast("Transaction saved to Google Sheet.", "success");
    await loadAndRender();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Save failed.", "danger");
  } finally {
    const btn = document.getElementById("submitBtn");
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-send me-2"></i>Save Transaction`;
  }
});

// Boot
document.getElementById("year").textContent = new Date().getFullYear();
dateInput.value = todayISO();
updateTypeUI();
loadAndRender();
