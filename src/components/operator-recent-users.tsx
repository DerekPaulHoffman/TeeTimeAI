import type { OperatorOverview } from "@/lib/operator/overview";

type RecentUsers = OperatorOverview["recentUsers"];

export function OperatorRecentUsers({ users }: { users: RecentUsers }) {
  return (
    <section aria-labelledby="users-heading" className="operator-section">
      <div className="operator-section-heading">
        <div>
          <p className="eyebrow">Registered accounts</p>
          <h2 id="users-heading">Recent users</h2>
          <p>
            Account and saved-alert activity for real users. Anonymous visitors
            are not identified.
          </p>
        </div>
      </div>
      {users.length > 0 ? (
        <div className="operator-table-wrap">
          <table className="operator-table operator-user-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Joined</th>
                <th>Total alerts</th>
                <th>Active</th>
                <th>Latest alert</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td data-label="Email">
                    <details className="operator-user-details">
                      <summary>{user.email}</summary>
                      <p>
                        {user.courseNames.length > 0
                          ? user.courseNames.join(", ")
                          : "No saved courses"}
                      </p>
                    </details>
                  </td>
                  <td data-label="Joined">{formatDate(user.createdAt)}</td>
                  <td data-label="Total alerts">{user.totalAlerts}</td>
                  <td data-label="Active">{user.activeAlerts}</td>
                  <td data-label="Latest alert">
                    {user.latestAlertAt
                      ? formatDateTime(user.latestAlertAt)
                      : "No alert yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="operator-empty">No registered users yet.</p>
      )}
    </section>
  );
}

function formatDate(value: Date) {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York"
  });
}

function formatDateTime(value: Date) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short"
  });
}
