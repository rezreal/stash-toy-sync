// Adds the "Interactive" tab to stash's scene page, next to the other tabs
// (same patches TCode Player used): a Nav.Link in ScenePage.Tabs and its
// Tab.Pane in ScenePage.TabContent. The after-fns run inside stash's render,
// so they only return elements; all state lives in SceneTab.
import { pluginApi } from "../ui/pluginApi.ts";
import type { StashScene } from "../player/ToySyncSlot.tsx";
import { SCENE_TAB_KEY, SceneTab } from "./SceneTab.tsx";

let registered = false;

export function registerSceneTab(): void {
  if (registered) return;
  registered = true;
  const api = pluginApi();
  const Nav = api.libraries.Bootstrap?.Nav;
  const Tab = api.libraries.Bootstrap?.Tab;
  if (!Nav?.Item || !Nav.Link || !Tab?.Pane || typeof api.patch?.after !== "function") {
    console.warn("[toysync] this stash can't add scene tabs; the Interactive tab is unavailable");
    return;
  }
  const { Item, Link } = Nav;
  const Pane = Tab.Pane;
  api.patch.after("ScenePage.Tabs", (...args: unknown[]) => (
    <>
      {args[args.length - 1]}
      <Item key="toysync-tab">
        <Link eventKey={SCENE_TAB_KEY}>Interactive</Link>
      </Item>
    </>
  ));
  api.patch.after("ScenePage.TabContent", (...args: unknown[]) => {
    const props = args[0] as { scene?: StashScene } | undefined;
    return (
      <>
        {args[args.length - 1]}
        <Pane key="toysync-pane" eventKey={SCENE_TAB_KEY}>
          <SceneTab scene={props?.scene} />
        </Pane>
      </>
    );
  });
}
