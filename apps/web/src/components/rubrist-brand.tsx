export interface RubristBrandProps {
  className?: string;
  markClassName?: string;
  nameClassName?: string;
}

export function RubristBrand({
  className = "",
  markClassName = "size-5",
  nameClassName = ""
}: RubristBrandProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <img
        src="/brand/rubrist-app-icon.svg"
        alt=""
        aria-hidden="true"
        className={`shrink-0 object-contain ${markClassName}`.trim()}
      />
      <span className={nameClassName}>rubrist</span>
    </span>
  );
}
