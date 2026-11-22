import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import {
  ListResponse,
  UserBadgeRow,
  UserBeerRow,
  UserDetail,
  UserFriendRow,
  UserNotificationRow,
} from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState, Loading } from "../components/States";
import MaskedValue from "../components/MaskedValue";
import { fmtBool, fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

type Tab = "beers" | "badges" | "friends" | "notifications";

function TabList({ userId, tab }: { userId: string; tab: Tab }) {
  const controls = useListControls("id");
  const path = `/users/${userId}/${tab}`;
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<any>>(path, controls.params),
    [path, JSON.stringify(controls.params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;

  let columns: any[] = [];
  let emptyMessage = "No records. This table is empty in this database for this user.";
  if (tab === "beers") {
    emptyMessage = "This user has not tried any beers in this database.";
    columns = [
      { key: "id", label: "ID" },
      { key: "beer", label: "Beer", render: (r: UserBeerRow) => <Link to={`/admin/catalog/beers/${r.beer.id}`}>{r.beer.name}</Link> },
      { key: "liked", label: "Liked", render: (r: UserBeerRow) => fmtBool(r.liked) },
      { key: "created_at", label: "Created", render: (r: UserBeerRow) => fmtDate(r.created_at) },
    ];
  } else if (tab === "badges") {
    emptyMessage = "This user has no badge records in this database.";
    columns = [
      { key: "id", label: "ID" },
      { key: "collection", label: "Collection", render: (r: UserBadgeRow) => <Link to={`/admin/catalog/collections/${r.collection.id}`}>{r.collection.name}</Link> },
      { key: "earned", label: "Earned", render: (r: UserBadgeRow) => fmtBool(r.earned) },
      { key: "progress", label: "Progress", render: (r: UserBadgeRow) => r.progress },
    ];
  } else if (tab === "friends") {
    emptyMessage = "This user has no friends in this database.";
    columns = [
      { key: "id", label: "ID" },
      { key: "other_user", label: "Friend", render: (r: UserFriendRow) => <Link to={`/admin/users/${r.other_user.id}`}>{r.other_user.user_name}</Link> },
      { key: "created_at", label: "Created", render: (r: UserFriendRow) => fmtDate(r.created_at) },
    ];
  } else {
    emptyMessage = "This user has no notifications in this database.";
    columns = [
      { key: "id", label: "ID" },
      { key: "type", label: "Type" },
      { key: "message", label: "Message" },
      { key: "viewed", label: "Viewed", render: (r: UserNotificationRow) => fmtBool(r.viewed) },
      { key: "created_at", label: "Created", render: (r: UserNotificationRow) => fmtDate(r.created_at) },
    ];
  }

  return (
    <div>
      <DataTable loading={loading} rows={data?.results ?? []} columns={columns} emptyMessage={emptyMessage} />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
}

const UserDetailPage: React.FC = () => {
  const { id } = useParams();
  const [tab, setTab] = useState<Tab>("beers");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<UserDetail>(`/users/${id}`),
    [id]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="User not found" onRetry={reload} />;
  const tabs: { key: Tab; label: string }[] = [
    { key: "beers", label: "Beers" },
    { key: "badges", label: "Badges" },
    { key: "friends", label: "Friends" },
    { key: "notifications", label: "Notifications" },
  ];
  return (
    <div>
      <h1>{data.user_name}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">UID</span><MaskedValue value={data.uid} /></div>
        <div><span className="field-label">Email</span>{data.email}</div>
        <div><span className="field-label">Age</span>{fmtVal(data.age)}</div>
        <div><span className="field-label">Private</span>{fmtBool(data.private)}</div>
        <div><span className="field-label">Created</span>{fmtDate(data.created_at)}</div>
        <div><span className="field-label">Beers tried</span>{data.beer_count}</div>
        <div><span className="field-label">Badges</span>{data.badge_count}</div>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? "tab active" : "tab"} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <TabList userId={String(id)} tab={tab} />
    </div>
  );
};

export default UserDetailPage;
