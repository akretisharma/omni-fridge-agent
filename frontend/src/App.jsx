import { NavLink, Route, Routes } from 'react-router-dom';
import CameraPage from './pages/CameraPage.jsx';
import PurchasesPage from './pages/PurchasesPage.jsx';

export default function App() {
  return (
    <>
      <header>
        <h1>🎙️ Say a goal. 📷 We check the fridge. 🛒 Zip buys what's missing.</h1>
        <nav>
          <NavLink to="/" end>Live camera</NavLink>
          <NavLink to="/purchases">Zip purchases</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<CameraPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
      </Routes>
    </>
  );
}
