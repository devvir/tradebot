import { useState } from 'react';

const NAV_LINKS = [
  { label: 'Buy Crypto', href: 'https://www.bitmex.com/app/buyCrypto' },
  { label: 'Markets',    href: 'https://www.bitmex.com/app/markets' },
  { label: 'Trade',      href: 'https://www.bitmex.com/app/trade/XBTUSD' },
  { label: 'Tools',      href: 'https://www.bitmex.com/app/leaderboard' },
  { label: 'Learn',      href: 'https://blog.bitmex.com/' },
  { label: 'Rewards Hub',href: 'https://www.bitmex.com/current-promotions' },
];

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
    <path d="M24 12L16 22 8 12z" />
  </svg>
);

export function Header() {
  const [_menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="organisms__Header__root__HGNAh">

      {/* Logo */}
      <div className="organisms__Header__logo__f5DFm">
        <a href="https://www.bitmex.com/" className="organisms__Header__logoSizing__L2ZN7">
          <svg viewBox="0 0 101 15">
            <path d="M4.05822 0.9021L0.522766 14.1525H3.89571L6.08415 5.94731H9.24042L10.5874 0.9021H4.05822Z" fill="#E11B00" />
            <path d="M13.96 0.9021L11.7679 9.10733H8.61528L7.26826 14.1525H10.4209H10.8579H13.7939L17.3329 0.9021H13.96Z" fill="#221C91" />
            <path d="M22.4379 12.6538H29.4294C31.1808 12.6538 32.2534 11.7329 32.2534 10.3641C32.2534 9.01705 31.1844 8.09612 29.4294 8.09612H22.4379V12.6538ZM28.9671 6.58653C30.7366 6.58653 31.8273 5.90397 31.8273 4.50272C31.8273 3.08342 30.7403 2.40085 28.9671 2.40085H22.4379V6.59015H28.9671V6.58653ZM20.7406 0.9021H29.1152C31.8995 0.9021 33.5065 2.13722 33.5065 4.35104C33.5065 6.04843 32.3617 6.89712 31.3469 7.24743C32.8601 7.65191 33.9471 8.8148 33.9471 10.4941C33.9471 12.8019 32.1775 14.1453 29.5016 14.1453H20.7406V0.9021Z" fill="#FFF" />
            <path d="M35.919 14.1489H37.7282V4.50272H35.919V14.1489ZM35.919 2.82339H37.7282V0.9021H35.919V2.82339Z" fill="#FFF" />
            <path d="M41.8774 5.87869H39.5554V4.47022H41.8774V0.9021H43.5061V4.47022H47.9336V5.87869H43.5061V10.8914C43.5061 12.2457 44.3114 12.6646 45.756 12.6646C46.5613 12.6646 47.2908 12.4804 47.9877 12.224L48.6161 13.5169C47.883 13.8094 46.471 14.1453 45.4996 14.1453C43.4881 14.1453 41.8774 13.34 41.8774 11.0359V5.87869Z" fill="#FFF" />
            <path d="M63.2311 0.9021L59.3815 9.76461L55.5427 0.9021H50.3388V14.1489H53.8635V5.29363L57.7312 14.1489H60.9849L64.8382 5.29363V14.1489H68.3447V0.9021H63.2311Z" fill="#FFF" />
          </svg>
        </a>
      </div>

      {/* Nav links */}
      <nav className="organisms__Header__links__hDmTM">
        {NAV_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="organisms__Header__link__oZ4NN organisms__Header__dropdownButton__Juhua"
          >
            <span>{link.label}</span>
            <ChevronDown />
          </a>
        ))}
        <div className="organisms__Header__link__oZ4NN organisms__Header__dropdownButton__Juhua" onClick={() => setMenuOpen(v => ! v)}>
          More
          <ChevronDown />
        </div>
      </nav>

      {/* End items */}
      <div className="organisms__Header__endItems__QW1Zt">

        {/* Bell */}
        <div className="organisms__Header__link__oZ4NN">
          <div className="molecules__Announcements__announcementsIconContainer__ppAen">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--OnBackground-High-Emphasis)">
              <path d="M14.4,10.1L13,8.8V6.5c0-2.6-1.9-4.7-4.5-5v-1h-1v1C5,1.8,3,3.9,3,6.5v2.3l-1.4,1.3c-0.1,0.1-0.2,0.2-0.1,0.4V12 c0,0.3,0.2,0.5,0.4,0.5c0,0,0,0,0.1,0h3.5C5.5,13.9,6.6,15,8,15s2.5-1.1,2.5-2.5H14c0.3,0,0.5-0.2,0.5-0.4c0,0,0,0,0-0.1v-1.5 C14.5,10.4,14.4,10.2,14.4,10.1z M8,14c-0.8,0-1.5-0.7-1.5-1.5h3C9.5,13.3,8.8,14,8,14z M13.5,11.5h-11v-0.8l1.3-1.4 C3.9,9.3,4,9.1,4,9V6.5c0-2.2,1.8-4,4-4s4,1.8,4,4V9c0,0.1,0.1,0.3,0.1,0.4l1.4,1.3V11.5z" />
            </svg>
          </div>
        </div>

        {/* Settings */}
        <div className="organisms__Header__link__oZ4NN">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--OnBackground-High-Emphasis)">
            <path d="M7.5 1H8.5V3.5H7.5z" />
            <path d="M10.8 3.4H13.3V4.4H10.8z" transform="rotate(-45.001 12.041 3.923)" />
            <path d="M12.5 7.5H15V8.5H12.5z" />
            <path d="M11.6 10.8H12.6V13.3H11.6z" transform="rotate(-45.001 12.075 12.041)" />
            <path d="M7.5 12.5H8.5V15H7.5z" />
            <path d="M2.7 11.6H5.2V12.6H2.7z" transform="rotate(-45.001 3.96 12.079)" />
            <path d="M1 7.5H3.5V8.5H1z" />
            <path d="M3.4 2.7H4.4V5.2H3.4z" transform="rotate(-45.001 3.925 3.961)" />
            <path d="M8,6c1.1,0,2,0.9,2,2s-0.9,2-2,2S6,9.1,6,8S6.9,6,8,6 M8,5C6.3,5,5,6.3,5,8s1.3,3,3,3s3-1.3,3-3S9.7,5,8,5z" />
          </svg>
        </div>

        {/* Login / Sign up */}
        <div className="organisms__Header__loginRegisterButtons__YCQmI">
          <button type="button" className="bmxc-button-root bmxc-button-outline bmxc-button-small">Login</button>
          <button type="button" className="bmxc-button-root bmxc-button-primary bmxc-button-small">Sign Up</button>
        </div>

      </div>
    </header>
  );
}
