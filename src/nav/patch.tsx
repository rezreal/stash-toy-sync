// Puts the device menu into stash's navbar (MainNavBar.UtilityItems, like
// TCode Player did), before whatever is already there. The after-fn runs in
// stash's render: it only returns elements.
import { pluginApi } from "../ui/pluginApi.ts";
import { NavMenu } from "./NavMenu.tsx";

let registered = false;

export function registerNavMenu(): void {
  if (registered) return;
  registered = true;
  const api = pluginApi();
  if (typeof api.patch?.after !== "function") return;
  api.patch.after("MainNavBar.UtilityItems", (...args: unknown[]) => (
    <>
      <NavMenu key="toysync-nav" />
      {args[args.length - 1]}
    </>
  ));
}
