import React, { useState } from "react";
import headerCover from "../assets/BetaMessageHeader.svg";
import { Typography } from "antd";
const { Text } = Typography;

type BetaPopupProps = {
  title?: string;
  message?: string;
  onReportBug?: () => void;
  onFeedback?: () => void;
  onContribute?: () => void;
};

const BetaPopup: React.FC<BetaPopupProps> = () => {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(0, 0, 0, 0.35)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 2000000,
        fontFamily: "Google Sans Flex, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "#fff",
          borderRadius: "8px",
          maxWidth: "480px",
          width: "90%",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
          textAlign: "center",
          height: "auto",
          maxHeight: "90vh",
          overflow: "auto",
          padding: 0,
        }}
      >
        <img
          src={headerCover}
          alt="Beta Header"
          style={{
            width: "100%",
            borderRadius: "8px 8px 0 0",
            display: "block",
          }}
        />
        <div style={{ padding: "40px 24px" }}>
          <h2
            style={{
              fontFamily: "Google Sans Flex, sans-serif",
              fontSize: "20px",
              fontWeight: 600,
              color: "#262626",
              margin: "0 0 16px 0",
            }}
          >
            Beta Feedback Requested
          </h2>
          <p
            style={{
              fontFamily: "Google Sans Flex, sans-serif",
              fontSize: "14px",
              color: "#595959",
              lineHeight: "1.5",
              margin: "0 0 12px 0",
            }}
          >
            You are currently using a beta version of this application. If you
            encounter any bugs, malfunctions, or have suggestions for
            improvement, we encourage you to share your feedback.
          </p>
          <p
            style={{
              fontFamily: "Google Sans Flex, sans-serif",
              fontSize: "14px",
              color: "#595959",
              lineHeight: "1.5",
              margin: "0 0 20px 0",
              marginBottom: "40px !important",
            }}
          >
            Please email us at <Text strong>contact@alteradatasuite.com</Text>
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: "12px",
              width: "100%",
            }}
          >
            <button
              onClick={() => setVisible(false)}
              style={{
                padding: "8px 16px",
                borderRadius: "5px",
                border: "none",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: 500,
                backgroundColor: "#FE4D41",
                color: "#fff",
                transition: "200ms",
                flex: "1 1 auto",
                minWidth: "100px",
                maxWidth: "150px",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#FF6040";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#FE4D41";
              }}
            >
              Got it!
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BetaPopup;
