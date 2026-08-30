import React from "react";
import GrooveSwitch from "./GrooveSwitch";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const Toggle: React.FC<ToggleProps> = ({ checked, onChange }) => {
  return <GrooveSwitch checked={checked} onChange={onChange} />;
};

export default Toggle;
