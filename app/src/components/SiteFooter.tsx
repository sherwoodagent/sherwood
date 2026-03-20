interface SiteFooterProps {
  left: string;
  right: string;
}

export default function SiteFooter({ left, right }: SiteFooterProps) {
  return (
    <footer className="site-footer font-[family-name:var(--font-plus-jakarta)]">
      <div>{left}</div>
      <div>{right}</div>
    </footer>
  );
}
