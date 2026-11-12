// The plugin's pages. stash mounts every PluginApi.register.route() as a
// plain, non-exact <Route> next to its own (no <Switch>), so one
// registration for /toysync covers /toysync/calibrate too; which page shows
// is decided here from the pathname. No nav entry: the bar under the player
// links here.
import { pluginApi } from "../ui/pluginApi.ts";
import { CalibratePage } from "./CalibratePage.tsx";
import { DevicesPage } from "./DevicesPage.tsx";
import { DEVICES_ROUTE, pageFor } from "./links.ts";

function ToySyncRoutes() {
  const location = pluginApi().libraries.ReactRouterDOM.useLocation();
  const page = pageFor(location.pathname);
  if (page === "devices") return <DevicesPage />;
  if (page === "calibrate") return <CalibratePage />;
  return null;
}

let registered = false;

export function registerPages(): void {
  if (registered) return;
  registered = true;
  const api = pluginApi();
  if (typeof api.register?.route !== "function") {
    console.warn("[toysync] this stash can't register plugin pages; the devices page is unavailable");
    return;
  }
  api.register.route(DEVICES_ROUTE, ToySyncRoutes);
}
