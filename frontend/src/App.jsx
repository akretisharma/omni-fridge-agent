import { MotionConfig } from 'motion/react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Aperture, ShoppingCartSimple, VideoCamera } from '@phosphor-icons/react';
import CameraPage from './pages/CameraPage.jsx';
import PurchasesPage from './pages/PurchasesPage.jsx';

const navClass = ({ isActive }) =>
  [
    'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-medium transition duration-200',
    isActive ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg hover:bg-surface-2',
  ].join(' ');

export default function App() {
  return (
    // Honour the OS "reduce motion" setting for every animation in the app.
    <MotionConfig reducedMotion="user">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center justify-between px-4 md:px-6">
          <NavLink to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <Aperture size={22} weight="regular" className="text-accent-ink" aria-hidden />
            Fridge Agent
          </NavLink>
          <nav className="flex items-center gap-1" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              <VideoCamera size={18} weight="regular" aria-hidden />
              Live
            </NavLink>
            <NavLink to="/purchases" className={navClass}>
              <ShoppingCartSimple size={18} weight="regular" aria-hidden />
              Purchases
            </NavLink>
          </nav>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<CameraPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
      </Routes>
    </MotionConfig>
  );
}
