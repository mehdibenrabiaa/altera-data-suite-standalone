import { InfoCircleOutlined, LinkOutlined } from "@ant-design/icons";
import SectionCard from "./SectionCard";
import styles from "../styles/Settings.module.css";
import logo from "../assets/Altera logo for settings.svg";
import type { SystemVersionInfo } from "./ActivationTab";

interface SystemInfoRow {
  label: string;
  value: string;
  mono: boolean;
}

interface LinkItem {
  label: string;
  href: string;
}

interface AboutTabProps {
  systemInfo?: SystemVersionInfo | null;
}

const AboutTab: React.FC<AboutTabProps> = ({ systemInfo }) => {
  const systemRows: SystemInfoRow[] = [
    { label: "Suite Version", value: systemInfo?.suiteVersion ?? "…", mono: true },
    { label: "OS", value: systemInfo?.os ?? "…", mono: false },
  ];

  const links: LinkItem[] = [
    { label: "Documentation", href: "https://alteradatasuite.com/en/docs" },
    { label: "Changelog", href: "https://alteradatasuite.com/en/changelog" },
    { label: "Contact Support", href: "mailto:support@alteradatasuite.com" },
  ];

  return (
    <>
      <div className={styles.heroBanner}>
        <img src={logo} className={styles.heroLogo} />
        <div>
          <div className={styles.heroName}>Altera Data Suite</div>
          <div className={styles.heroTagline}>
            Turning Unstructured Data into Intelligent Action.
          </div>
        </div>
      </div>

      <SectionCard
        title="System Information"
        icon={<InfoCircleOutlined />}
      >
        {systemRows.map((r) => (
          <div key={r.label} className={styles.infoRow}>
            <span className={styles.infoLabel}>{r.label}</span>
            <span
              className={`${styles.infoValue} ${r.mono ? styles.mono : ""}`}
            >
              {r.value}
            </span>
          </div>
        ))}
      </SectionCard>

      <SectionCard
        title="Resources"
        icon={<LinkOutlined />}
      >
        {links.map((l) => (
          <a
            key={l.label}
            className={styles.linkRow}
            href={l.href}
            onClick={(e) => {
              if (l.href === "#") return;
              e.preventDefault();
              window.alteraStudio.openExternalUrl(l.href);
            }}
          >
            <LinkOutlined />
            {l.label}
          </a>
        ))}
      </SectionCard>

      <div className={styles.copyright}>
        © 2026 Altera. All rights reserved.
      </div>
    </>
  );
};

export default AboutTab;
