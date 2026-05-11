import { Navbar } from '@/components/home/Navbar';
import { Hero } from '@/components/home/Hero';
import { HowItWorks } from '@/components/home/HowItWorks';
import { Features } from '@/components/home/Features';
import { DemoPreview } from '@/components/home/DemoPreview';
import { TrustDisclaimer } from '@/components/home/TrustDisclaimer';
import { Footer } from '@/components/home/Footer';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white dark:bg-gray-950">
      <Navbar />
      <Hero />
      <HowItWorks />
      <Features />
      <DemoPreview />
      <TrustDisclaimer />
      <Footer />
    </main>
  );
}
