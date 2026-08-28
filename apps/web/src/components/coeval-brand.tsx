export interface CoevalBrandProps {
  className?: string;
  markClassName?: string;
  nameClassName?: string;
}

export function CoevalBrand({
  className = "",
  markClassName = "size-5",
  nameClassName = ""
}: CoevalBrandProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <img
        src="/brand/coeval-app-icon.png"
        alt=""
        aria-hidden="true"
        className={`shrink-0 object-contain ${markClassName}`.trim()}
      />
      <span className={nameClassName}>coeval</span>
    </span>
  );
}
