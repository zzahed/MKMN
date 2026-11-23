// The CSS custom properties the window sets from React, typed so a style object needs no cast.
import "react";

declare module "react" {
  interface CSSProperties {
    /** The voice level (0 to 1) the composer's meter draws. */
    "--lvl"?: string;
    /** A starter button's place in the row, for the staggered entrance. */
    "--i"?: number;
  }
}
