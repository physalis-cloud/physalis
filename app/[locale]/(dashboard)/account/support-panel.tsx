"use client";

// Onglet Support du compte. Liste les tickets du user, permet d'en créer un
// nouveau et de suivre/répondre à un fil. Toutes les requêtes passent par les
// routes proxy /api/support/* (qui ajoutent le SUPPORT_SERVICE_TOKEN côté
// serveur) — le token n'atteint jamais le navigateur.

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  RiCustomerService2Line,
  RiArrowLeftLine,
} from "@remixicon/react";

type Status = "OPEN" | "WAITING" | "RESOLVED" | "CLOSED";

type Ticket = {
  ref: string;
  subject: string;
  status: Status;
  createdAt: string;
  lastReplyAt: string | null;
  lastReplyBy: "REQUESTER" | "STAFF" | null;
};

type Message = {
  id: string;
  authorRole: "REQUESTER" | "STAFF";
  authorName: string | null;
  body: string;
  createdAt: string;
};

const STATUS_COLOR: Record<Status, { bg: string; fg: string }> = {
  OPEN: { bg: "rgba(59, 130, 246, 0.15)", fg: "#3b82f6" },
  WAITING: { bg: "rgba(202, 148, 63, 0.18)", fg: "#b8860b" },
  RESOLVED: { bg: "rgba(34, 197, 94, 0.15)", fg: "#16a34a" },
  CLOSED: { bg: "rgba(120, 120, 120, 0.15)", fg: "#6b7280" },
};

export default function SupportPanel() {
  const t = useTranslations("account.support");
  const locale = useLocale();

  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openRef, setOpenRef] = useState<string | null>(null);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/support/tickets");
    if (!res.ok) {
      setError(t("loadError"));
      setTickets([]);
      return;
    }
    const data = (await res.json()) as { tickets: Ticket[] };
    setTickets(data.tickets);
  }, [t]);

  useEffect(() => {
    reload();
  }, [reload]);

  function statusChip(status: Status) {
    const c = STATUS_COLOR[status];
    return (
      <span
        className="chip"
        style={{ fontSize: 10, background: c.bg, color: c.fg, marginLeft: 8 }}
      >
        {t(`status.${status}`)}
      </span>
    );
  }

  // ── Vue détail (fil) ───────────────────────────────────────────────
  if (openRef) {
    return (
      <TicketThread
        ticketRef={openRef}
        onBack={() => {
          setOpenRef(null);
          reload();
        }}
        fmt={fmt}
        statusChip={statusChip}
      />
    );
  }

  // ── Vue liste ──────────────────────────────────────────────────────
  return (
    <div>
      <div className="settings-block-row" style={{ marginBottom: 6 }}>
        <h2 className="settings-block-title" style={{ margin: 0 }}>{t("title")}</h2>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-primary btn-sm"
          >
            {t("newBtn")}
          </button>
        )}
      </div>
      <p className="settings-section-desc">{t("desc")}</p>

      {error && <p className="error-text">{error}</p>}

      {creating && (
        <NewTicketForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {tickets === null ? (
        <p className="help">{t("loading")}</p>
      ) : tickets.length === 0 ? (
        !creating && (
          <div className="empty-state">
            <div className="empty-state-title">{t("emptyTitle")}</div>
            <div>{t("emptyHint")}</div>
          </div>
        )
      ) : (
        <div className="row-list">
          {tickets.map((tk) => (
            <button
              key={tk.ref}
              type="button"
              className="row"
              onClick={() => setOpenRef(tk.ref)}
              style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
            >
              <div className="row-icon">
                <RiCustomerService2Line size={18} aria-hidden />
              </div>
              <div className="row-info">
                <div className="row-name">
                  {tk.subject}
                  {statusChip(tk.status)}
                </div>
                <div className="row-meta">
                  <code className="code-mono" style={{ fontSize: 11 }}>{tk.ref}</code>
                  <span> · {t("openedAt", { time: fmt(tk.createdAt) })}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Formulaire nouveau ticket ─────────────────────────────────────────
function NewTicketForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("account.support");
  const locale = useLocale();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (subject.trim().length < 3 || message.trim().length < 1) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), message: message.trim(), locale }),
      });
      if (!res.ok) {
        setError(t("createError"));
        return;
      }
      onCreated();
    });
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>{t("subjectLabel")}</label>
        <input
          autoFocus
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t("subjectPlaceholder")}
          className="input"
          maxLength={300}
          disabled={pending}
          required
        />
      </div>
      <div className="field">
        <label>{t("messageLabel")}</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("messagePlaceholder")}
          className="input"
          rows={6}
          maxLength={20000}
          disabled={pending}
          required
        />
      </div>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <button
          type="submit"
          disabled={pending || subject.trim().length < 3 || message.trim().length < 1}
          className="btn btn-primary btn-sm"
        >
          {pending ? t("submittingBtn") : t("submitBtn")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm" disabled={pending}>
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}

// ── Fil d'un ticket ───────────────────────────────────────────────────
function TicketThread({
  ticketRef,
  onBack,
  fmt,
  statusChip,
}: {
  ticketRef: string;
  onBack: () => void;
  fmt: (iso: string) => string;
  statusChip: (status: Status) => React.ReactNode;
}) {
  const t = useTranslations("account.support");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    fetch(`/api/support/tickets/${encodeURIComponent(ticketRef)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ ticket: Ticket; messages: Message[] }>;
      })
      .then((data) => {
        if (!active) return;
        setTicket(data.ticket);
        setMessages(data.messages);
      })
      .catch(() => active && setNotFound(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ticketRef]);

  function submitReply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reply.trim().length < 1) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/support/tickets/${encodeURIComponent(ticketRef)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: reply.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { message?: Message } | null;
      if (!res.ok || !data?.message) {
        setError(t("replyError"));
        return;
      }
      setMessages((prev) => [...prev, data.message!]);
      setReply("");
      setTicket((prev) => (prev ? { ...prev, status: "OPEN" } : prev));
    });
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }}>
        <RiArrowLeftLine size={15} aria-hidden /> {t("backBtn")}
      </button>

      {loading ? (
        <p className="help">{t("loading")}</p>
      ) : notFound || !ticket ? (
        <div className="empty-state">
          <div className="empty-state-title">{t("notFound")}</div>
        </div>
      ) : (
        <>
          <div className="settings-block-row" style={{ marginBottom: 4 }}>
            <h2 className="settings-block-title" style={{ margin: 0 }}>
              {ticket.subject}
              {statusChip(ticket.status)}
            </h2>
          </div>
          <p className="settings-section-desc">
            <code className="code-mono" style={{ fontSize: 11 }}>{ticket.ref}</code>
          </p>

          <div className="row-list" style={{ marginBottom: 16 }}>
            {messages.map((m) => (
              <div
                key={m.id}
                className="card"
                style={{
                  padding: 12,
                  background:
                    m.authorRole === "STAFF" ? "var(--accent-bg, rgba(202,148,63,0.08))" : undefined,
                }}
              >
                <div className="row-meta" style={{ marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
                  <strong style={{ fontSize: 13 }}>
                    {m.authorRole === "STAFF" ? t("staff") : t("you")}
                  </strong>
                  <span>{fmt(m.createdAt)}</span>
                </div>
                <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body}</p>
              </div>
            ))}
          </div>

          {ticket.status !== "CLOSED" && (
            <form onSubmit={submitReply}>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={t("replyPlaceholder")}
                className="input"
                rows={4}
                maxLength={20000}
                disabled={pending}
              />
              {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
              <div style={{ marginTop: 10 }}>
                <button
                  type="submit"
                  disabled={pending || reply.trim().length < 1}
                  className="btn btn-primary btn-sm"
                >
                  {pending ? t("replyingBtn") : t("replyBtn")}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
