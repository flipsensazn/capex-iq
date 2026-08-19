import { Fragment, useEffect, useState } from "react";
import { EYEBROW_STYLE, PANEL_STYLE } from "./ResearchPanel";

const FEATURES = [
  { key: "research", label: "Research", color: "var(--accent)" },
  { key: "radar", label: "Radar", color: "var(--info)" },
  { key: "funds", label: "Funds", color: "var(--event)" },
  { key: "signals", label: "Signals", color: "var(--warn)" },
];

const ALL_FEATURES = Object.fromEntries(FEATURES.map(({ key }) => [key, true]));

const CELL_STYLE = {
  padding: "10px 12px",
  borderTop: "1px solid var(--border-hairline)",
  color: "var(--ink-300)",
  fontSize: 10.5,
  textAlign: "left",
  verticalAlign: "middle",
};

const ACTION_STYLE = {
  borderRadius: "var(--radius-md)",
  padding: "5px 9px",
  cursor: "pointer",
  fontFamily: "var(--font-condensed)",
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

function formatDate(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "—";
}

async function readResponse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    // The status-specific fallback below remains useful for non-JSON errors.
  }

  if (!response.ok) {
    if (data?.code === "admin_only") {
      throw new Error("Member administration is available to admins only.");
    }
    if (response.status === 401) {
      throw new Error("Sign in again to review member registrations.");
    }
    throw new Error(data?.error || data?.message || `Member request failed (${response.status}).`);
  }

  if (!data) throw new Error("Member request returned an invalid response.");
  return data;
}

export default function MembersPanel() {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutation, setMutation] = useState(null);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState(null);
  const [rosterNotices, setRosterNotices] = useState([]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMembers() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/members", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await readResponse(response);
        if (!Array.isArray(data.members)) {
          throw new Error("Member request returned an invalid member list.");
        }
        if (!controller.signal.aborted) setMembers(data.members);
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load member registrations.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadMembers();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!deleteConfirmEmail) return undefined;
    const timeout = window.setTimeout(() => setDeleteConfirmEmail(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [deleteConfirmEmail]);

  async function mutateMember(action, email) {
    setMutation({ action, email });
    setError("");

    const body = { action, email };
    if (action === "grant") {
      body.features = ALL_FEATURES;
      body.researchQuota = 50;
    }

    try {
      const response = await fetch("/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readResponse(response);

      let noticeEmail = email;
      if (action === "delete") {
        setMembers(current => current.filter(member => member.email !== email));
      } else {
        if (!data.member || typeof data.member !== "object") {
          throw new Error("Member update returned no record.");
        }
        setMembers(current => current.map(member => (
          member.email === email ? data.member : member
        )));
        noticeEmail = data.member.email;
      }

      const rosterSynced = data.roster?.synced === true;
      let rosterMessage = null;
      if (action === "grant") {
        if (rosterSynced) {
          rosterMessage = "Added to the Zero Trust members list — they can sign in now.";
        } else {
          const reason = data.roster?.reason === "unconfigured"
            ? "roster sync unconfigured"
            : "roster sync failed — add manually";
          rosterMessage = `Also add this email to the Capex IQ Members list in Zero Trust so they can sign in. (${reason})`;
        }
      } else if (!rosterSynced) {
        rosterMessage = "Remove them from the Zero Trust list manually to reclaim the seat.";
      }
      setRosterNotices(current => [
        ...current.filter(notice => notice.email !== noticeEmail),
        ...(rosterMessage ? [{ email: noticeEmail, message: rosterMessage, synced: rosterSynced }] : []),
      ]);
      setDeleteConfirmEmail(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update that member.");
    } finally {
      setMutation(null);
    }
  }

  function requestDelete(email) {
    if (deleteConfirmEmail === email) {
      void mutateMember("delete", email);
      return;
    }
    setDeleteConfirmEmail(email);
  }

  function dismissRosterNotice(email) {
    setRosterNotices(current => current.filter(notice => notice.email !== email));
  }

  const removedMemberNotices = rosterNotices.filter(notice => (
    !members.some(member => member.email === notice.email)
  ));

  return (
    <section style={{ ...PANEL_STYLE, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", flexWrap: "wrap" }}>
        <div style={EYEBROW_STYLE}>MEMBER REGISTRATIONS</div>
        <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>
          {loading ? "Loading registrations…" : `${members.length} registration${members.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {error && (
        <div role="alert" style={{ margin: "0 16px 12px", padding: "7px 10px", color: "var(--down-400)", background: "color-mix(in srgb, var(--down-400) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--down-400) 30%, transparent)", borderRadius: "var(--radius-md)", fontSize: 10.5 }}>
          {error}
        </div>
      )}

      {removedMemberNotices.map(notice => (
        <div key={notice.email} role="status" style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 16px 12px", color: "var(--accent)", fontSize: 10, lineHeight: 1.45 }}>
          <span><span style={{ fontFamily: "var(--font-mono)" }}>{notice.email}</span>: {notice.message}</span>
          <button
            type="button"
            aria-label={`Dismiss reminder for ${notice.email}`}
            onClick={() => dismissRosterNotice(notice.email)}
            style={{ marginLeft: "auto", padding: 2, color: "var(--ink-500)", background: "transparent", border: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 14, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      ))}

      {loading ? (
        <div style={{ padding: "4px 16px 16px", color: "var(--ink-400)", fontSize: 12 }}>Loading member registrations…</div>
      ) : !members.length && !error ? (
        <div style={{ padding: "4px 16px 16px", color: "var(--ink-400)", fontSize: 12 }}>No registrations yet.</div>
      ) : members.length > 0 ? (
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table style={{ width: "100%", minWidth: 920, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  ["Email", "28%"],
                  ["Registered", "110px"],
                  ["Source", "110px"],
                  ["Features", "330px"],
                  ["Usage", "70px"],
                  ["Actions", "220px"],
                ].map(([label, width]) => (
                  <th key={label} style={{ ...EYEBROW_STYLE, width, padding: "8px 12px", borderTop: "1px solid var(--border-hairline)", textAlign: "left" }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map(member => {
                const featureValues = member.features && typeof member.features === "object" && !Array.isArray(member.features)
                  ? member.features
                  : {};
                const featuresEmpty = Object.keys(featureValues).length === 0;
                const busy = mutation?.email === member.email;
                const rosterNotice = rosterNotices.find(notice => notice.email === member.email);

                return (
                  <Fragment key={member.email}>
                    <tr>
                      <td style={{ ...CELL_STYLE, color: "var(--ink-100)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                        {member.email}
                      </td>
                      <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                        {formatDate(member.registeredAt)}
                      </td>
                      <td style={CELL_STYLE}>{member.source || "—"}</td>
                      <td style={CELL_STYLE}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          {FEATURES.map(feature => {
                            const enabled = featureValues[feature.key] === true;
                            return (
                              <span key={feature.key} style={{ color: enabled ? feature.color : "var(--ink-600)", background: enabled ? `color-mix(in srgb, ${feature.color} 10%, transparent)` : "transparent", border: `1px solid ${enabled ? `color-mix(in srgb, ${feature.color} 35%, transparent)` : "var(--border-hairline)"}`, borderRadius: "var(--radius-pill)", padding: "3px 8px", fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 800, letterSpacing: "0.05em" }}>
                                {feature.label}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                        {member.usage ? `${member.usage.used}/${member.usage.limit}` : "—"}
                      </td>
                      <td style={CELL_STYLE}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          {featuresEmpty ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void mutateMember("grant", member.email)}
                              style={{ ...ACTION_STYLE, color: "var(--up-400)", background: "color-mix(in srgb, var(--up-400) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--up-400) 35%, transparent)", opacity: busy ? 0.5 : 1, cursor: busy ? "wait" : "pointer" }}
                            >
                              Grant member
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void mutateMember("revoke", member.email)}
                              style={{ ...ACTION_STYLE, color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)", opacity: busy ? 0.5 : 1, cursor: busy ? "wait" : "pointer" }}
                            >
                              Revoke
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => requestDelete(member.email)}
                            style={{ ...ACTION_STYLE, color: "var(--down-400)", background: deleteConfirmEmail === member.email ? "color-mix(in srgb, var(--down-400) 14%, transparent)" : "transparent", border: "1px solid color-mix(in srgb, var(--down-400) 30%, transparent)", opacity: busy ? 0.5 : 1, cursor: busy ? "wait" : "pointer" }}
                          >
                            {deleteConfirmEmail === member.email ? "Confirm delete?" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {rosterNotice && (
                      <tr>
                        <td colSpan={6} style={{ padding: "0 12px 10px", borderTop: "1px solid var(--border-hairline)" }}>
                          <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, color: rosterNotice.synced ? "var(--up-400)" : "var(--accent)", fontSize: 10, lineHeight: 1.45 }}>
                            <span>{rosterNotice.message}</span>
                            <button
                              type="button"
                              aria-label={`Dismiss reminder for ${member.email}`}
                              onClick={() => dismissRosterNotice(member.email)}
                              style={{ marginLeft: "auto", padding: 2, color: "var(--ink-500)", background: "transparent", border: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 14, lineHeight: 1 }}
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
