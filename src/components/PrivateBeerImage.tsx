import React, { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { PresignedImageResponse } from "../api/types";
import { initialsFor } from "./helpers";

// Renders an approved product image that lives in private storage (the
// beverage detail carries kind "product" with image_url null for those).
// Asks the API for a short-lived presigned URL and renders it; on any
// failure it keeps the plain initials fallback, exactly like a beverage
// with no image at all.
const PrivateBeerImage: React.FC<{ beverageId: number; name: string }> = ({
  beverageId,
  name,
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    apiGet<PresignedImageResponse>(`/images/${beverageId}`)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [beverageId]);

  if (url) {
    return <img className="beer-image" src={url} alt={name} />;
  }
  return (
    <>
      <div className="initials-block">{initialsFor(name)}</div>
      {failed ? <p>No approved image exists for this beer.</p> : null}
    </>
  );
};

export default PrivateBeerImage;
