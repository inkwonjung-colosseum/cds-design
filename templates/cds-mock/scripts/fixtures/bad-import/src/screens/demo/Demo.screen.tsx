import { Button } from "@colosseumcoinckr/cds/components/button";
import { shared } from "../../other/Shared.mock";
import "./demo.css";

export const meta = { title: "데모" };

export default function DemoScreen() {
  return <Button>{shared}</Button>;
}
