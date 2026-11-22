import React, { useState } from "react";

export const MaskedValue: React.FC<{ value: string | null | undefined }> = ({
  value,
}) => {
  const [revealed, setRevealed] = useState(false);
  if (!value) return <span>None</span>;
  const masked = `${value.slice(0, 4)}...`;
  return (
    <button
      type="button"
      className="masked-value"
      onClick={() => setRevealed((r) => !r)}
      title={revealed ? "Hide value" : "Reveal value"}
    >
      {revealed ? value : masked}
    </button>
  );
};

export default MaskedValue;
