import React from "react";
import { Card, Typography } from "antd";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;

interface SectionCardProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const SectionCard: React.FC<SectionCardProps> = ({ title, icon, children }) => {
  return (
    <Card
      className={styles.sectionCard}
      title={
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Text strong className={styles.sectionTitle}>
            {title}
          </Text>
        </div>
      }
      bordered={false}
      size="small"
    >
      {children}
    </Card>
  );
};

export default SectionCard;
