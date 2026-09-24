import React, { useCallback, useEffect, useState } from "react";
import { Button, Typography } from "antd";
import { AppstoreAddOutlined, CloudDownloadOutlined, DeleteOutlined, WarningFilled } from "@ant-design/icons";
import SectionCard from "./SectionCard";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;

interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface PluginListEntry {
  manifest: PluginManifest;
  error: string | null;
}

interface RemotePlugin {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
}

// A "Plugins" tab, alongside Preferences/Appearance/Activation/About --
// browses/installs/removes first-party node plugins (see src/plugins.ts
// and backend/app/plugins.py). Primary path is Browse Plugins, which
// fetches from altera-license-server (backend/app/plugins.py's
// fetch_remote_catalog/install_from_remote proxy it -- this tab never
// talks to that server directly, same boundary the rest of the app
// keeps). "Install from Folder" stays as a secondary, local/dev-oriented
// path for a plugin that isn't published yet.
function backendUrl(path: string): string {
  return `${window.alteraStudio.backendUrl}${path}`;
}

const PluginsTab: React.FC = () => {
  const [entries, setEntries] = useState<PluginListEntry[]>([]);
  const [remote, setRemote] = useState<RemotePlugin[]>([]);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => {
    try {
      const res = await fetch(backendUrl("/plugins/list"));
      const data = await res.json();
      setEntries(data.plugins ?? []);
    } catch {
      setEntries([]);
    }
  }, []);

  const refreshRemote = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const res = await fetch(backendUrl("/plugins/remote-catalog"));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Server responded ${res.status}`);
      }
      const data = await res.json();
      setRemote(data.plugins ?? []);
    } catch (e) {
      setRemote([]);
      setRemoteError(e instanceof Error ? e.message : "Couldn't reach the plugin server.");
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshLocal();
    refreshRemote();
  }, [refreshLocal, refreshRemote]);

  const installedIds = new Set(entries.map((e) => e.manifest.id));

  const handleInstallRemote = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(backendUrl(`/plugins/install/${id}`), { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Server responded ${res.status}`);
      }
      await refreshLocal();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed.");
    } finally {
      setBusyId(null);
    }
  };

  const handleInstallFolder = async () => {
    setBusyId("__folder__");
    setError(null);
    try {
      const err = await window.alteraStudio.installPlugin();
      if (err) setError(err);
      else await refreshLocal();
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const err = await window.alteraStudio.uninstallPlugin(id);
      if (err) setError(err);
      else await refreshLocal();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <SectionCard title="Browse Plugins" icon={<CloudDownloadOutlined />}>
        {remoteLoading ? (
          <div className={styles.settingRow}>
            <Text style={{ fontSize: 12, opacity: 0.6 }}>Loading…</Text>
          </div>
        ) : remoteError ? (
          <div className={styles.settingRow}>
            <Text type="danger" style={{ fontSize: 12 }}>{remoteError}</Text>
            <Button size="small" onClick={refreshRemote}>Retry</Button>
          </div>
        ) : remote.length === 0 ? (
          <div className={styles.settingRow}>
            <Text style={{ fontSize: 12, opacity: 0.6 }}>No plugins published yet.</Text>
          </div>
        ) : (
          remote.map((p) => {
            const installed = installedIds.has(p.id);
            return (
              <div key={p.id} className={styles.settingRow}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <Text strong className={styles.settingLabel}>{p.name}</Text>
                  <Text style={{ fontSize: 11.5, opacity: 0.6 }}>{p.description}</Text>
                </div>
                <Button
                  size="small"
                  type={installed ? "default" : "primary"}
                  loading={busyId === p.id}
                  disabled={installed}
                  onClick={() => handleInstallRemote(p.id)}
                >
                  {installed ? "Installed" : "Install"}
                </Button>
              </div>
            );
          })
        )}
      </SectionCard>

      <SectionCard title="Installed Plugins" icon={<AppstoreAddOutlined />}>
        <div className={styles.settingRow}>
          <Text strong className={styles.settingLabel}>Install from a local folder</Text>
          <Button size="small" loading={busyId === "__folder__"} onClick={handleInstallFolder}>
            Choose Folder…
          </Button>
        </div>
        {error && (
          <div className={styles.settingRow}>
            <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
          </div>
        )}
        {entries.length === 0 ? (
          <div className={styles.settingRow}>
            <Text style={{ fontSize: 12, opacity: 0.6 }}>No plugins installed.</Text>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.manifest.id} className={styles.settingRow}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <Text strong className={styles.settingLabel} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {entry.manifest.name || entry.manifest.id}
                  {entry.error && <WarningFilled style={{ color: "#b8860b", fontSize: 13 }} title={entry.error} />}
                </Text>
                <Text style={{ fontSize: 11.5, opacity: 0.6 }}>
                  {entry.error ?? entry.manifest.description}
                </Text>
              </div>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={busyId === entry.manifest.id}
                onClick={() => handleUninstall(entry.manifest.id)}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </SectionCard>
    </>
  );
};

export default PluginsTab;
