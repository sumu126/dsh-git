/**
 * The build's CSS Modules pipeline turns a stylesheet into a class map, and this
 * declaration is the shape the importing components see.
 */
declare module '*.module.css' {
  /** Hashed class names, keyed by the name written in the source. */
  const classes: Readonly<Record<string, string>>
  export default classes
}
