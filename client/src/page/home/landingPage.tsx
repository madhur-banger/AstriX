import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { 
  CheckCircle2, 
  Zap, 
  Users, 
  BarChart3, 
  Calendar,
  ArrowRight,
  Sparkles,
  Target,
  TrendingUp,
  GitBranch,
  Rocket,
  Activity,
  Star,
  Layers,
  Briefcase,
  
  Layout,
  // Folder,
  // Clock,
  // FileText,
  // PieChart,
  // Award,
  // TrendingDown,
  // MessageSquare,
  Shield
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const LandingPage = () => {
  const navigate = useNavigate();
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [inView, setInView] = useState<{ [key: string]: boolean }>({});
  const sectionRefs = useRef<{ [key: string]: HTMLElement | null }>({});

  console.log(scrollY);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    
    const handleScroll = () => {
      setScrollY(window.scrollY);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('scroll', handleScroll);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          setInView((prev) => ({
            ...prev,
            [entry.target.id]: entry.isIntersecting,
          }));
        });
      },
      { threshold: 0.1 }
    );

    Object.values(sectionRefs.current).forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, []);

  // const FloatingIcon = ({ 
  //   icon: Icon, 
  //   delay, 
  //   duration, 
  //   startX, 
  //   startY,
  //   scale = 1 
  // }: any) => (
  //   <div
  //     className="absolute opacity-20 dark:opacity-10"
  //     style={{
  //       left: `${startX}%`,
  //       top: `${startY}%`,
  //       animation: `float ${duration}s ease-in-out infinite`,
  //       animationDelay: `${delay}s`,
  //       transform: `scale(${scale})`,
  //     }}
  //   >
  //     <Icon className="w-8 h-8 text-gray-600 dark:text-gray-400" />
  //   </div>
  // );

  const features = [
    {
      icon: Target,
      title: "Smart Task Management",
      description: "Organize, prioritize, and track tasks with intelligent automation and AI-powered suggestions"
    },
    {
      icon: Users,
      title: "Team Collaboration",
      description: "Work together seamlessly with real-time updates, notifications, and integrated chat"
    },
    {
      icon: BarChart3,
      title: "Analytics & Insights",
      description: "Make data-driven decisions with powerful analytics dashboards and custom reports"
    },
    {
      icon: Zap,
      title: "Lightning Fast",
      description: "Built for speed with optimized performance and instant updates across all devices"
    },
    {
      icon: Calendar,
      title: "Timeline View",
      description: "Visualize your project timeline, dependencies, and meet every deadline with ease"
    },
    {
      icon: GitBranch,
      title: "Workflow Automation",
      description: "Automate repetitive tasks and focus on what matters most with custom workflows"
    }
  ];

  const testimonials = [
    {
      company: "TechCorp",
      logo: Briefcase,
      quote: "Astrix transformed our project management. We've seen a 40% increase in team productivity.",
      author: "Sarah Johnson",
      role: "CTO",
      metric: "+40%",
      metricLabel: "Productivity"
    },
    {
      company: "DesignHub",
      logo: Layout,
      quote: "The best project management tool we've ever used. Our team collaboration has never been better.",
      author: "Michael Chen",
      role: "Head of Design",
      metric: "3x",
      metricLabel: "Faster Delivery"
    },
    {
      company: "StartupXYZ",
      logo: Rocket,
      quote: "We scaled from 5 to 50 people without missing a beat. Astrix grew with us seamlessly.",
      author: "Emily Rodriguez",
      role: "CEO",
      metric: "10x",
      metricLabel: "Team Growth"
    }
  ];

  const companyLogos = [
    { name: "TechCorp", icon: Briefcase },
    { name: "DesignHub", icon: Layout },
    { name: "StartupXYZ", icon: Rocket },
    { name: "DataFlow", icon: BarChart3 },
    { name: "CloudSync", icon: Layers },
    { name: "SecureNet", icon: Shield }
  ];

  const stats = [
    { label: "Active Users", value: "50K+", icon: Users },
    { label: "Tasks Completed", value: "2M+", icon: CheckCircle2 },
    { label: "Teams", value: "10K+", icon: Briefcase },
    { label: "Countries", value: "120+", icon: Target }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-white via-gray-50 to-gray-100 dark:from-[#0a0a0a] dark:via-[#111111] dark:to-[#0a0a0a] overflow-hidden">
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-30px) rotate(10deg); }
        }
        @keyframes floatSlow {
          0%, 100% { transform: translateY(0px) translateX(0px); }
          50% { transform: translateY(-15px) translateX(10px); }
        }
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes fadeInLeft {
          from {
            opacity: 0;
            transform: translateX(-50px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes fadeInRight {
          from {
            opacity: 0;
            transform: translateX(50px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes scaleIn {
          from {
            opacity: 0;
            transform: scale(0.8);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.05); }
        }
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes bounce-subtle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes slideInUp {
          from {
            opacity: 0;
            transform: translateY(100px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in-up {
          animation: fadeInUp 0.8s ease-out forwards;
        }
        .animate-fade-in-left {
          animation: fadeInLeft 1s ease-out forwards;
        }
        .animate-fade-in-right {
          animation: fadeInRight 1s ease-out forwards;
        }
        .animate-scale-in {
          animation: scaleIn 0.6s ease-out forwards;
        }
        .animate-slide-in-up {
          animation: slideInUp 0.8s ease-out forwards;
        }
        .gradient-text {
          background: linear-gradient(135deg, #000000 0%, #434343 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .dark .gradient-text {
          background: linear-gradient(135deg, #ffffff 0%, #a0a0a0 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .card-hover {
          transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .card-hover:hover {
          transform: translateY(-12px) scale(1.02);
          box-shadow: 0 25px 50px rgba(0, 0, 0, 0.15);
        }
        .dark .card-hover:hover {
          box-shadow: 0 25px 50px rgba(255, 255, 255, 0.08);
        }
        .graph-line {
          animation: drawLine 2s ease-out forwards;
        }
        @keyframes drawLine {
          from {
            stroke-dashoffset: 1000;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
        .productivity-graph {
          animation: fadeInRight 1.2s ease-out forwards;
        }
      `}</style>

      {/* Enhanced Floating Background Icons */}
      {/* <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <FloatingIcon icon={CheckCircle2} delay={0} duration={6} startX={10} startY={20} scale={1.2} />
        <FloatingIcon icon={Target} delay={1} duration={7} startX={85} startY={15} scale={1.1} />
        <FloatingIcon icon={TrendingUp} delay={0.5} duration={5} startX={15} startY={70} scale={1.3} />
        <FloatingIcon icon={Clock} delay={2} duration={8} startX={80} startY={65} scale={1} />
        <FloatingIcon icon={FileText} delay={1.5} duration={6} startX={50} startY={85} scale={1.2} />
        <FloatingIcon icon={Users} delay={0.8} duration={7} startX={70} startY={40} scale={1.1} />
        <FloatingIcon icon={Rocket} delay={1.2} duration={6.5} startX={25} startY={45} scale={1.4} />
        <FloatingIcon icon={Award} delay={0.3} duration={7.5} startX={90} startY={50} scale={1.2} />
        <FloatingIcon icon={Activity} delay={1.8} duration={6} startX={5} startY={55} scale={1.1} />
        <FloatingIcon icon={Star} delay={0.6} duration={8} startX={75} startY={25} scale={1.3} />
        <FloatingIcon icon={PieChart} delay={1.4} duration={7} startX={30} startY={10} scale={1} />
        <FloatingIcon icon={Folder} delay={0.9} duration={6.5} startX={60} startY={75} scale={1.2} />
      </div> */}

      {/* Enhanced Gradient Orb Effect */}
      <div 
        className="fixed w-[800px] h-[800px] rounded-full opacity-30 blur-3xl pointer-events-none transition-all duration-500"
        style={{
          background: 'radial-gradient(circle, rgba(0,0,0,0.4) 0%, transparent 70%)',
          left: mousePosition.x - 400,
          top: mousePosition.y - 400,
        }}
      />

      {/* Navigation */}
      <nav className="relative z-50 px-6 py-4 flex justify-between items-center max-w-7xl mx-auto backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-gradient-to-br from-black to-gray-700 dark:from-white dark:to-gray-300 rounded-lg flex items-center justify-center shadow-lg">
            <Sparkles className="w-6 h-6 text-white dark:text-black" />
          </div>
          <span className="text-2xl font-bold">Astrix</span>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" className="hidden sm:inline-flex">Features</Button>
          <Button variant="ghost" className="hidden sm:inline-flex">Pricing</Button>
          <Button variant="ghost" onClick={() => navigate('/sign-in')}>Sign In</Button>
          <Button 
            className="bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 shadow-lg"
            onClick={() => navigate('/sign-up')}
          >
            Get Started
            <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
        </div>
      </nav>

      {/* Hero Section - Split Layout */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-12 pb-24">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left Side - Text Content */}
          <div className="text-left">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gray-200 dark:bg-gray-800 mb-8 animate-fade-in-left">
              <Sparkles className="w-4 h-4" />
              <span className="text-sm font-medium">Introducing Astrix 2.0</span>
            </div>
            
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-6 animate-fade-in-left gradient-text" style={{ animationDelay: '0.1s' }}>
              Project Management
              <br />
              Reimagined
            </h1>
            
            <p className="text-xl text-gray-600 dark:text-gray-400 mb-10 animate-fade-in-left" style={{ animationDelay: '0.2s' }}>
              The all-in-one workspace for teams to plan, track, and deliver projects with unprecedented clarity and speed.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 mb-12 animate-fade-in-left" style={{ animationDelay: '0.3s' }}>
              <Button 
                size="lg" 
                className="bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 h-14 px-8 text-lg shadow-xl"
                onClick={() => navigate('/sign-up')}
              >
                Start Free Trial
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
              <Button size="lg" variant="outline" className="h-14 px-8 text-lg">
                Watch Demo
              </Button>
            </div>

            {/* Stats Below CTA */}
            <div className="grid grid-cols-2 gap-6 animate-fade-in-left" style={{ animationDelay: '0.4s' }}>
              {stats.slice(0, 2).map((stat, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 rounded-lg flex items-center justify-center">
                    <stat.icon className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">{stat.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Side - Productivity Graph */}
          <div className="relative productivity-graph">
            {/* Floating Icons around graph */}
            <div className="absolute -left-8 top-1/4 animate-scale-in" style={{ animationDelay: '0.6s', animation: 'floatSlow 4s ease-in-out infinite' }}>
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center shadow-xl">
                <TrendingUp className="w-8 h-8 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            
            <div className="absolute -right-8 top-1/3 animate-scale-in" style={{ animationDelay: '0.8s', animation: 'floatSlow 5s ease-in-out infinite'}}>
              <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-2xl flex items-center justify-center shadow-xl">
                <CheckCircle2 className="w-8 h-8 text-green-600 dark:text-green-400" />
              </div>
            </div>
            
            <div className="absolute left-1/4 -bottom-4 animate-scale-in" style={{ animationDelay: '1s', animation: 'floatSlow 4.5s ease-in-out infinite'}}>
              <div className="w-16 h-16 bg-purple-100 dark:bg-purple-900/30 rounded-2xl flex items-center justify-center shadow-xl">
                <Rocket className="w-8 h-8 text-purple-600 dark:text-purple-400" />
              </div>
            </div>
            
            <div className="absolute right-1/4 -top-4 animate-scale-in" style={{ animationDelay: '0.7s', animation: 'floatSlow 5.5s ease-in-out infinite' }}>
              <div className="w-16 h-16 bg-orange-100 dark:bg-orange-900/30 rounded-2xl flex items-center justify-center shadow-xl">
                <Target className="w-8 h-8 text-orange-600 dark:text-orange-400" />
              </div>
            </div>

            {/* Main Graph Card */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-8 border border-gray-200 dark:border-gray-800 animate-scale-in" style={{ animationDelay: '0.5s' }}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold mb-1">Team Productivity</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Last 6 months</p>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-green-100 dark:bg-green-900/30 rounded-full">
                  <TrendingUp className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <span className="text-sm font-semibold text-green-600 dark:text-green-400">+127%</span>
                </div>
              </div>
              
              {/* SVG Graph */}
              <svg className="w-full h-64" viewBox="0 0 400 200">
                <defs>
                  <linearGradient id="graphGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="rgba(0,0,0,0.1)" />
                    <stop offset="100%" stopColor="rgba(0,0,0,0)" />
                  </linearGradient>
                </defs>
                
                {/* Grid lines */}
                {[0, 1, 2, 3, 4].map((i) => (
                  <line
                    key={i}
                    x1="0"
                    y1={i * 50}
                    x2="400"
                    y2={i * 50}
                    stroke="currentColor"
                    strokeWidth="1"
                    opacity="0.1"
                  />
                ))}
                
                {/* Area under curve */}
                <path
                  d="M 0 180 L 0 150 Q 66 120, 133 100 T 266 60 T 400 30 L 400 180 Z"
                  fill="url(#graphGradient)"
                  opacity="0.3"
                />
                
                {/* Main line */}
                <path
                  d="M 0 150 Q 66 120, 133 100 T 266 60 T 400 30"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray="1000"
                  className="graph-line"
                />
                
                {/* Data points */}
                {[
                  { x: 0, y: 150 },
                  { x: 133, y: 100 },
                  { x: 266, y: 60 },
                  { x: 400, y: 30 }
                ].map((point, i) => (
                  <circle
                    key={i}
                    cx={point.x}
                    cy={point.y}
                    r="6"
                    fill="currentColor"
                    className="animate-scale-in"
                    style={{ animationDelay: `${1 + i * 0.2}s` }}
                  />
                ))}
              </svg>
              
              {/* Month labels */}
              <div className="flex justify-between mt-4 text-xs text-gray-600 dark:text-gray-400">
                <span>Jan</span>
                <span>Mar</span>
                <span>May</span>
                <span>Jul</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trusted By Section */}
      <section 
        id="trusted-by"
        ref={(el) => (sectionRefs.current['trusted-by'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-16"
      >
        <div className={`text-center mb-12 ${inView['trusted-by'] ? 'animate-fade-in-up' : 'opacity-0'}`}>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-8">TRUSTED BY LEADING TEAMS</p>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-8 items-center">
            {companyLogos.map((company, i) => (
              <div
                key={i}
                className={`flex flex-col items-center gap-2 ${inView['trusted-by'] ? 'animate-fade-in-up' : 'opacity-0'}`}
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-xl flex items-center justify-center">
                  <company.icon className="w-8 h-8 text-gray-600 dark:text-gray-400" />
                </div>
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{company.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Animated Features Section */}
      <section 
        id="features"
        ref={(el) => (sectionRefs.current['features'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-24"
      >
        <div className={`text-center mb-16 ${inView['features'] ? 'animate-fade-in-up' : 'opacity-0'}`}>
          <h2 className="text-4xl sm:text-5xl font-bold mb-4">Everything you need</h2>
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Powerful features designed to help your team collaborate and deliver faster
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, i) => (
            <div
              key={i}
              className={`card-hover bg-white dark:bg-gray-900 p-8 rounded-xl border border-gray-200 dark:border-gray-800 ${inView['features'] ? 'animate-fade-in-up' : 'opacity-0'}`}
              style={{ animationDelay: `${i * 0.1}s` }}
            >
              <div className="w-14 h-14 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 rounded-xl flex items-center justify-center mb-4 shadow-md">
                <feature.icon className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
              <p className="text-gray-600 dark:text-gray-400">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonials Section */}
      <section 
        id="testimonials"
        ref={(el) => (sectionRefs.current['testimonials'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-24"
      >
        <div className={`text-center mb-16 ${inView['testimonials'] ? 'animate-fade-in-up' : 'opacity-0'}`}>
          <h2 className="text-4xl sm:text-5xl font-bold mb-4">Loved by teams worldwide</h2>
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            See how Astrix is transforming the way teams work
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {testimonials.map((testimonial, i) => (
            <div
              key={i}
              className={`card-hover bg-white dark:bg-gray-900 p-8 rounded-2xl border border-gray-200 dark:border-gray-800 ${inView['testimonials'] ? 'animate-slide-in-up' : 'opacity-0'}`}
              style={{ animationDelay: `${i * 0.15}s` }}
            >
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 rounded-xl flex items-center justify-center">
                  <testimonial.logo className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold">{testimonial.company}</h4>
                  <div className="flex gap-1 mt-1">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                    ))}
                  </div>
                </div>
              </div>
              
              <blockquote className="text-gray-600 dark:text-gray-400 mb-6 italic">
                "{testimonial.quote}"
              </blockquote>
              
              <div className="flex items-center justify-between pt-6 border-t border-gray-200 dark:border-gray-800">
                <div>
                  <p className="font-semibold">{testimonial.author}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{testimonial.role}</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">{testimonial.metric}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">{testimonial.metricLabel}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Stats Section with Animation */}
      <section 
        id="stats"
        ref={(el) => (sectionRefs.current['stats'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-24"
      >
        <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 rounded-3xl p-12 sm:p-16 border border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            {stats.map((stat, i) => (
              <div
                key={i}
                className={`text-center ${inView['stats'] ? 'animate-scale-in' : 'opacity-0'}`}
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                <div className="w-16 h-16 mx-auto mb-4 bg-white dark:bg-gray-900 rounded-xl flex items-center justify-center shadow-lg">
                  <stat.icon className="w-8 h-8" />
                </div>
                <div className="text-4xl sm:text-5xl font-bold mb-2">{stat.value}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Visual Feature Showcase with Graphs */}
      <section 
        id="showcase"
        ref={(el) => (sectionRefs.current['showcase'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-24"
      >
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Task Analytics */}
          <div className={`${inView['showcase'] ? 'animate-fade-in-left' : 'opacity-0'}`}>
            <div className="mb-8">
              <h3 className="text-3xl font-bold mb-4">Real-time Analytics</h3>
              <p className="text-lg text-gray-600 dark:text-gray-400">
                Track team performance, identify bottlenecks, and optimize workflows with intelligent insights.
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-6 border border-gray-200 dark:border-gray-800">
              <div className="flex items-center justify-between mb-6">
                <h4 className="font-semibold">Task Completion Rate</h4>
                <div className="flex items-center gap-2 px-3 py-1 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                  <Activity className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">92%</span>
                </div>
              </div>
              
              <div className="space-y-4">
                {[
                  { label: 'Completed', value: 92, color: 'bg-green-500' },
                  { label: 'In Progress', value: 67, color: 'bg-blue-500' },
                  { label: 'Pending', value: 45, color: 'bg-yellow-500' }
                ].map((item, i) => (
                  <div key={i} className="animate-fade-in-up" style={{ animationDelay: `${0.5 + i * 0.1}s` }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{item.label}</span>
                      <span className="text-sm font-bold">{item.value}%</span>
                    </div>
                    <div className="w-full h-3 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${item.color} rounded-full transition-all duration-1000`}
                        style={{ width: inView['showcase'] ? `${item.value}%` : '0%' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Pie Chart Visualization */}
          <div className={`${inView['showcase'] ? 'animate-fade-in-right' : 'opacity-0'}`}>
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 border border-gray-200 dark:border-gray-800 relative">
              {/* Floating elements around pie chart */}
              <div className="absolute -left-4 top-1/4" style={{ animation: 'bounce-subtle 3s ease-in-out infinite' }}>
                <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center shadow-lg">
                  <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400" />
                </div>
              </div>
              
              <div className="absolute -right-4 top-2/3" style={{ animation: 'bounce-subtle 3s ease-in-out infinite', animationDelay: '0.5s' }}>
                <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center shadow-lg">
                  <BarChart3 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
              </div>

              <h4 className="font-semibold mb-6 text-center">Project Distribution</h4>
              
              <svg className="w-full max-w-xs mx-auto" viewBox="0 0 200 200">
                <circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" strokeWidth="40" opacity="0.1" />
                
                {/* Animated pie segments */}
                <circle
                  cx="100"
                  cy="100"
                  r="80"
                  fill="none"
                  stroke="rgb(34, 197, 94)"
                  strokeWidth="40"
                  strokeDasharray="251 503"
                  strokeDashoffset="0"
                  transform="rotate(-90 100 100)"
                  className={inView['showcase'] ? 'graph-line' : ''}
                />
                <circle
                  cx="100"
                  cy="100"
                  r="80"
                  fill="none"
                  stroke="rgb(59, 130, 246)"
                  strokeWidth="40"
                  strokeDasharray="157 503"
                  strokeDashoffset="-251"
                  transform="rotate(-90 100 100)"
                  className={inView['showcase'] ? 'graph-line' : ''}
                  style={{ animationDelay: '0.3s' }}
                />
                <circle
                  cx="100"
                  cy="100"
                  r="80"
                  fill="none"
                  stroke="rgb(251, 191, 36)"
                  strokeWidth="40"
                  strokeDasharray="95 503"
                  strokeDashoffset="-408"
                  transform="rotate(-90 100 100)"
                  className={inView['showcase'] ? 'graph-line' : ''}
                  style={{ animationDelay: '0.6s' }}
                />
                
                {/* Center text */}
                <text x="100" y="95" textAnchor="middle" className="text-3xl font-bold" fill="currentColor">156</text>
                <text x="100" y="115" textAnchor="middle" className="text-sm" fill="currentColor" opacity="0.6">Total Projects</text>
              </svg>
              
              <div className="mt-8 space-y-3">
                {[
                  { label: 'Active', color: 'bg-green-500', value: '78' },
                  { label: 'Planning', color: 'bg-blue-500', value: '49' },
                  { label: 'Completed', color: 'bg-yellow-500', value: '29' }
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-4 h-4 ${item.color} rounded`} />
                      <span className="text-sm font-medium">{item.label}</span>
                    </div>
                    <span className="text-sm font-bold">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section 
        id="cta"
        ref={(el) => (sectionRefs.current['cta'] = el)}
        className="relative z-10 max-w-7xl mx-auto px-6 py-24"
      >
        <div className={`bg-gradient-to-br from-black to-gray-800 dark:from-white dark:to-gray-200 rounded-3xl p-12 sm:p-16 text-center text-white dark:text-black relative overflow-hidden ${inView['cta'] ? 'animate-scale-in' : 'opacity-0'}`}>
          {/* Floating elements in CTA */}
          <div className="absolute top-8 left-8 opacity-20" style={{ animation: 'float 6s ease-in-out infinite' }}>
            <Rocket className="w-16 h-16" />
          </div>
          <div className="absolute bottom-8 right-8 opacity-20" style={{ animation: 'float 7s ease-in-out infinite', animationDelay: '1s' }}>
            <Star className="w-20 h-20" />
          </div>
          <div className="absolute top-1/2 right-16 opacity-20" style={{ animation: 'float 5s ease-in-out infinite', animationDelay: '0.5s' }}>
            <Target className="w-12 h-12" />
          </div>
          
          <div className="relative z-10">
            <h2 className="text-4xl sm:text-5xl font-bold mb-6">
              Ready to transform your workflow?
            </h2>
            <p className="text-xl opacity-90 mb-10 max-w-2xl mx-auto">
              Join thousands of teams already using Astrix to deliver better projects, faster.
            </p>
            <Button 
              size="lg" 
              variant="secondary" 
              className="h-14 px-8 text-lg bg-white dark:bg-black text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-900 shadow-2xl"
              onClick={() => navigate('/sign-up')}
            >
              Get Started Free
              <ArrowRight className="ml-2 w-5 h-5" />
            </Button>
            <p className="mt-4 text-sm opacity-75">No credit card required • 14-day free trial</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 max-w-7xl mx-auto px-6 py-12 border-t border-gray-200 dark:border-gray-800">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-black to-gray-700 dark:from-white dark:to-gray-300 rounded-lg flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white dark:text-black" />
            </div>
            <span className="text-lg font-bold">Astrix</span>
          </div>
          <div className="flex gap-6 text-sm text-gray-600 dark:text-gray-400">
            <a href="#" className="hover:text-gray-900 dark:hover:text-gray-100">Privacy</a>
            <a href="#" className="hover:text-gray-900 dark:hover:text-gray-100">Terms</a>
            <a href="#" className="hover:text-gray-900 dark:hover:text-gray-100">Contact</a>
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            © 2025 Astrix. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;