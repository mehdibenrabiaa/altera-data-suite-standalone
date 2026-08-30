import React, { useState, useEffect, useCallback } from "react";
import { Input, Button, Space } from "antd";
import {
  KeyOutlined,
  CopyOutlined,
  CheckOutlined,
  CloseCircleFilled,
  HourglassOutlined,
  SafetyCertificateFilled,
  WarningFilled,
} from "@ant-design/icons";
import type { LicenseStatus } from "../settingsAppTypes";
import styles from "../styles/Settings.module.css";

// ── Real licensing backend ──────────────────────────────────────────────────
// Talks to this app's own FastAPI backend (backend/app/routers/licensing.py),
// which is a direct port of the Qt Settings widget's licensing logic
// (orangecontrib/custom/widgets/settings_business_logic.py) -- same machine
// ID derivation, same JWT verification, same production license server
// (https://backend.alteradatasuite.com). This is real, not simulated.
function backendUrl(path: string): string {
  return `${window.alteraStudio.backendUrl}${path}`;
}

export interface SystemVersionInfo {
  suiteVersion: string;
  orangeVersion: string;
  os: string;
}

interface ActivationTabProps {
  // No `licenseStatus` prop -- unlike Appearance/About, this tab is
  // self-sufficient: it fetches its own status from the real backend on
  // mount rather than being handed one, since it owns the only source of
  // truth for it. onActivate/onStatusChange still let the parent (About's
  // hero area, etc.) mirror the result if it ever wants to.
  onActivate: (info: { email: string; plan: string; expiry: string }) => void;
  onDeactivate: () => void;
  onStatusChange?: (status: LicenseStatus) => void;
  onSystemInfo?: (info: SystemVersionInfo) => void;
}

interface Feedback {
  type: "error" | "success";
  msg: string;
}

// Lucide's refresh-ccw icon (public/refresh-ccw.svg), inlined so its
// `stroke="currentColor"` picks up the surrounding text color -- spun via
// styles.spinIcon (Settings.module.css) for the "Checking license…" loader.
function RefreshCcwGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#999999" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

// The backend's /licensing/check response has 4 real states (no_license |
// invalid | expired | valid) -- "trial" isn't one of them, it's `state:
// "valid"` with `plan: "trial"`. "no_license" and "invalid" both render as
// the same "not activated" screen below, so they fold into one UI state.
function toLicenseStatus(data: any): LicenseStatus {
  if (data.state === "valid") {
    const isTrial = (data.plan ?? "").toLowerCase() === "trial";
    return {
      state: isTrial ? "trial" : "valid",
      email: data.email || undefined,
      plan: data.plan || undefined,
      expiry: data.expiry_date || undefined,
      message: data.message,
    };
  }
  if (data.state === "expired") {
    return {
      state: "expired",
      email: data.email || undefined,
      plan: data.plan || undefined,
      expiry: data.expiry_date || undefined,
      message: data.message,
    };
  }
  return { state: "invalid", message: data.message };
}

const ActivationTab: React.FC<ActivationTabProps> = ({
  onActivate,
  onDeactivate,
  onStatusChange,
  onSystemInfo,
}) => {
  const [keyInput, setKeyInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [checking, setChecking] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [copied, setCopied] = useState(false);
  const [machineId, setMachineId] = useState("…");
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(backendUrl("/licensing/check"));
      const data = await res.json();
      const s = toLicenseStatus(data);
      setStatus(s);
      onStatusChange?.(s);
      if (s.state === "valid") {
        onActivate({ email: s.email ?? "", plan: s.plan ?? "", expiry: s.expiry ?? "" });
      }
    } catch {
      setStatus({ state: "invalid", message: "Could not reach the license service." });
    } finally {
      setChecking(false);
    }
  }, [onActivate, onStatusChange]);

  useEffect(() => {
    fetch(backendUrl("/licensing/machine-id"))
      .then((r) => r.json())
      .then((d) => setMachineId(d.machine_id))
      .catch(() => {});
    fetch(backendUrl("/licensing/system-info"))
      .then((r) => r.json())
      .then((d) => onSystemInfo?.({ suiteVersion: d.suite_version, orangeVersion: d.orange_version, os: d.os }))
      .catch(() => {});
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleActivate = async (): Promise<void> => {
    if (!keyInput.trim()) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(backendUrl("/licensing/activate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: keyInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        const s: LicenseStatus = {
          state: (data.plan ?? "").toLowerCase() === "trial" ? "trial" : "valid",
          email: data.email || undefined,
          plan: data.plan || undefined,
          expiry: data.expiry_date || undefined,
        };
        setStatus(s);
        onActivate({ email: data.email ?? "", plan: data.plan ?? "", expiry: data.expiry_date ?? "" });
        onStatusChange?.(s);
        setFeedback({ type: "success", msg: "License activated successfully." });
        setKeyInput("");
      } else {
        setFeedback({ type: "error", msg: data.error ?? "Activation failed." });
      }
    } catch {
      setFeedback({ type: "error", msg: "No internet connection." });
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateClick = async (): Promise<void> => {
    setDeactivating(true);
    try {
      await fetch(backendUrl("/licensing/deactivate"), { method: "POST" });
    } catch {
      // Deactivation clears the local keyring entry regardless of whether
      // the server call succeeded -- same "always clear locally" behavior
      // as the ported Python (license_logic.deactivate_license).
    }
    const s: LicenseStatus = { state: "invalid" };
    setStatus(s);
    onDeactivate();
    onStatusChange?.(s);
    setDeactivating(false);
  };

  const handleCopy = (): void => {
    navigator.clipboard.writeText(machineId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Render: checking spinner ──────────────────────────────────────────────
  if (checking || status === null) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 10,
        }}
      >
        <RefreshCcwGlyph className="activation-spin-icon" />
        <span style={{ fontSize: 12, color: "#999999" }}>
          Checking license…
        </span>
      </div>
    );
  }

  // ── Render: not activated ─────────────────────────────────────────────────
  if (status.state === "invalid") {
    return (
      <>
        <div className={`${styles.stateBanner} ${styles["stateBanner--danger"]}`}>
          <CloseCircleFilled className={styles.stateBannerIcon} />
          <div>
            <div className={styles.stateBannerTitle}>
              Altera Data Suite is not activated
            </div>
            <div className={styles.stateBannerDesc}>
              {status.message ?? "This copy of Altera Data Suite has not been activated on this machine."}
              <br />
              Enter your license key below to unlock all features.
            </div>
          </div>
        </div>

        <div className={`${styles.noticeRow} ${styles["noticeRow--danger"]}`}>
          <WarningFilled style={{ fontSize: 12 }} />
          Without activation, some features may be restricted.
        </div>

        <div className={styles.activationBody}>
          <div className={styles.activationLabel}>Enter License Key</div>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              prefix={<KeyOutlined style={{ color: "#999999" }} />}
              placeholder="ADS-XXXX-XXXXXXXX-XXXX"
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setFeedback(null);
              }}
              onPressEnter={handleActivate}
              status={feedback?.type === "error" ? "error" : undefined}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
            />
            <Button
              type="primary"
              onClick={handleActivate}
              loading={loading}
              disabled={!keyInput.trim()}
            >
              Activate
            </Button>
          </Space.Compact>

          {feedback && (
            <div className={`${styles.feedbackMsg} ${feedback.type === "error" ? styles.error : styles.success}`}>
              {feedback.type === "error" ? "⚠ " : "✓ "}
              {feedback.msg}
            </div>
          )}

          <div className={styles.helpText}>
            Don't have a license? Visit our website at{" "}
            <a href="#">alteradatasuite.com</a>
          </div>
        </div>

        <div className={styles.machineIdSection}>
          <div className={styles.machineIdLabel}>
            Machine Identifier — share with support to activate on this machine
          </div>
          <div className={styles.machineIdBox}>
            <span className={styles.machineIdVal}>{machineId}</span>
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>
      </>
    );
  }

  // ── Render: expired ──────────────────────────────────────────────────────
  if (status.state === "expired") {
    return (
      <>
        <div className={`${styles.stateBanner} ${styles["stateBanner--danger"]}`}>
          <HourglassOutlined className={styles.stateBannerIcon} />
          <div>
            <div className={styles.stateBannerTitle}>
              Your license has expired
            </div>
            <div className={styles.stateBannerDesc}>
              Your Altera Data Suite license expired on{" "}
              <strong>
                {status.expiry
                  ? new Date(status.expiry).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })
                  : "—"}
              </strong>
              {status.plan && (
                <>
                  <br />
                  Plan: <strong>{status.plan}</strong>
                </>
              )}
            </div>
          </div>
        </div>

        <div className={`${styles.noticeRow} ${styles["noticeRow--danger"]}`}>
          <WarningFilled style={{ fontSize: 12 }} />
          Renew to restore full access.
        </div>

        <div className={styles.activationBody}>
          <div className={styles.activationLabel}>
            Enter New License Key to Reactivate
          </div>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              prefix={<KeyOutlined style={{ color: "#999999" }} />}
              placeholder="ADS-XXXX-XXXXXXXX-XXXX"
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setFeedback(null);
              }}
              onPressEnter={handleActivate}
              status={feedback?.type === "error" ? "error" : undefined}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
            />
            <Button
              type="primary"
              onClick={handleActivate}
              loading={loading}
              disabled={!keyInput.trim()}
            >
              Reactivate
            </Button>
          </Space.Compact>

          {feedback && (
            <div className={`${styles.feedbackMsg} ${feedback.type === "error" ? styles.error : styles.success}`}>
              {feedback.type === "error" ? "⚠ " : "✓ "}
              {feedback.msg}
            </div>
          )}

          <div className={styles.helpText}>
            Need to renew? Visit our website at{" "}
            <a href="#">alteradatasuite.com</a>
          </div>
        </div>

        <div className={styles.machineIdSection}>
          <div className={styles.machineIdLabel}>
            Machine Identifier — share with support to activate on this machine
          </div>
          <div className={styles.machineIdBox}>
            <span className={styles.machineIdVal}>{machineId}</span>
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>
      </>
    );
  }

  // ── Render: licensed (valid, non-trial) ───────────────────────────────────
  if (status.state === "valid") {
    const validExpiry = status.expiry ? new Date(status.expiry) : null;
    const validDaysLeft = validExpiry
      ? Math.max(0, Math.ceil((validExpiry.getTime() - Date.now()) / 86_400_000))
      : null;
    const validExpiringSoon = validDaysLeft !== null && validDaysLeft <= 30;

    return (
      <>
        <div className={`${styles.stateBanner} ${styles["stateBanner--success"]}`}>
          <SafetyCertificateFilled className={styles.stateBannerIcon} />
          <div>
            <div className={styles.stateBannerTitle}>
              Altera Data Suite is activated
            </div>
            <div className={styles.stateBannerDesc}>
              {status.email && (
                <>
                  Licensed to <strong>{status.email}</strong>
                  <br />
                </>
              )}
              {status.plan && <>Plan: <strong>{status.plan}</strong></>}
              {validExpiry && (
                <>
                  &nbsp;·&nbsp;Expires{" "}
                  <strong>
                    {validExpiry.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                  </strong>
                </>
              )}
              {validDaysLeft !== null && (
                <span
                  className={`${styles.stateBadge} ${validExpiringSoon ? styles["stateBadge--urgent"] : styles["stateBadge--normal"]}`}
                >
                  {validDaysLeft === 0
                    ? "Expires today"
                    : `${validDaysLeft} day${validDaysLeft !== 1 ? "s" : ""} left`}
                </span>
              )}
            </div>
          </div>
        </div>

        {validExpiringSoon ? (
          <div className={`${styles.noticeRow} ${styles["noticeRow--warning"]}`}>
            <WarningFilled style={{ fontSize: 12 }} />
            {`Your license expires in ${validDaysLeft} day${validDaysLeft !== 1 ? "s" : ""}. Contact us to renew.`}
          </div>
        ) : (
          <div className={`${styles.noticeRow} ${styles["noticeRow--success"]}`}>
            <CheckOutlined style={{ fontSize: 12 }} />
            All features are unlocked. Your license is valid and active.
          </div>
        )}

        <div className={styles.machineIdSection}>
          <div className={styles.machineIdLabel}>
            Machine Identifier — share with support to activate on this machine
          </div>
          <div className={styles.machineIdBox}>
            <span className={styles.machineIdVal}>{machineId}</span>
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>

        <div style={{ padding: "12px 16px" }}>
          <Button size="small" danger loading={deactivating} onClick={handleDeactivateClick}>
            Deactivate this machine
          </Button>
        </div>
      </>
    );
  }

  // ── Render: trial (state === "trial") ─────────────────────────────────────
  const trialExpiry = status.expiry ? new Date(status.expiry) : null;
  const daysRemaining = trialExpiry
    ? Math.max(0, Math.ceil((trialExpiry.getTime() - Date.now()) / 86_400_000))
    : null;
  const urgency = daysRemaining !== null && daysRemaining <= 7;

  return (
    <>
      <div className={`${styles.stateBanner} ${styles["stateBanner--trial"]}`}>
        <HourglassOutlined className={styles.stateBannerIcon} />
        <div>
          <div className={styles.stateBannerTitle}>Free Trial Active</div>
          <div className={styles.stateBannerDesc}>
            You are evaluating Altera Data Suite on a {daysRemaining !== null ? `${daysRemaining}-day` : "free"} free trial.
            {trialExpiry && (
              <>
                <br />
                Trial expires on{" "}
                <strong>
                  {trialExpiry.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                </strong>
                {daysRemaining !== null && (
                  <span
                    className={`${styles.stateBadge} ${urgency ? styles["stateBadge--urgent"] : styles["stateBadge--normal"]}`}
                  >
                    {daysRemaining === 0
                      ? "Expires today"
                      : `${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} left`}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {urgency && (
        <div className={`${styles.noticeRow} ${styles["noticeRow--warning"]}`}>
          <WarningFilled style={{ fontSize: 12 }} />
          Your trial is ending soon. Activate a license key to keep full access.
        </div>
      )}

      <div className={styles.activationBody}>
        <div className={styles.activationLabel}>
          Have a license key? Activate now
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            prefix={<KeyOutlined style={{ color: "#999999" }} />}
            placeholder="ADS-XXXX-XXXXXXXX-XXXX"
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setFeedback(null);
            }}
            onPressEnter={handleActivate}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
          />
          <Button
            type="primary"
            onClick={handleActivate}
            loading={loading}
            disabled={!keyInput.trim()}
          >
            Activate
          </Button>
        </Space.Compact>
        {feedback && (
          <div className={`${styles.feedbackMsg} ${feedback.type === "error" ? styles.error : styles.success}`}>
            {feedback.type === "error" ? "⚠ " : "✓ "}
            {feedback.msg}
          </div>
        )}
        <div className={styles.helpText}>
          No license yet? Visit our website at{" "}
          <a href="#">alteradatasuite.com</a>
        </div>
      </div>

      <div className={styles.machineIdSection}>
        <div className={styles.machineIdLabel}>Machine Identifier</div>
        <div className={styles.machineIdBox}>
          <span className={styles.machineIdVal}>{machineId}</span>
          <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>
    </>
  );
};

export default ActivationTab;
