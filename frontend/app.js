'use strict';
/* ════════════════════════════════════════════════════════════════════
   BACKEND INTEGRATION LAYER
   All network calls go through these helpers.
   Falls back gracefully when the server is not running.
════════════════════════════════════════════════════════════════════ */

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://${window.location.host}/api`
  : null;   // null = offline / file:// mode → use localStorage fallback

// Socket.io — connect only when a real server is present
let socket = null;
function connectSocket() {
  if (!API) return;
  try {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('[Socket] connected:', socket.id);
    });

    // ── Admin receives live events ──
    socket.on('admin:feed', ({ msg, type, time }) => {
      if (document.getElementById('adm-feed')) pushFeed(msg, type || 'info');
    });
    socket.on('admin:snapshot', ({ students, reports }) => {
      // Merge server live students into APP.students
      students.forEach(s => {
        const existing = APP.students.find(x => x.id === s.id);
        if (!existing) {
          APP.students.push({
            id: s.id, name: s.name, dept: s.dept||'General',
            score: s.intScore||100, viol: s.violations?.length||0,
            status: s.status||'active', vlist: s.violations?.map(v=>v.text)||[]
          });
        }
      });
      // Merge reports
      APP.adminReports = APP.adminReports || [];
      reports.forEach(r => {
        if (!APP.adminReports.find(x => x.reportId === r.reportId))
          APP.adminReports.push(r);
      });
      persistReports();
      if (document.getElementById('tab-dashboard')?.classList.contains('active')) renderDashboard();
    });
    socket.on('admin:student-join', (session) => {
      const existing = APP.students.find(s => s.id === session.id);
      if (!existing) {
        APP.students.push({
          id: session.id, name: session.name, dept: session.dept||'General',
          score: session.intScore||100, viol: 0, status: 'active', vlist: []
        });
        persistStudents();
        updateTopStats();
        if (document.getElementById('tab-monitor')?.classList.contains('active')) renderMonitorGrid();
      }
    });
    socket.on('admin:student-update', (upd) => {
      const st = APP.students.find(s => s.id === upd.id);
      if (st) {
        st.score  = upd.intScore  ?? st.score;
        st.status = upd.status    ?? st.status;
        st.viol   = upd.violations?.length ?? st.viol;
        const ibar = document.getElementById(`stu-ibar-${APP.students.indexOf(st)}`);
        if (ibar) ibar.style.width = st.score + '%';
        updateTopStats();
      }
    });
    socket.on('admin:report', (report) => {
      APP.adminReports = APP.adminReports || [];
      APP.adminReports.push(report);
      persistReports();
      if (document.getElementById('tab-reports')?.classList.contains('active')) renderReports();
    });

    // ── Student receives events ──
    socket.on('student:message', (msg) => {
      showProctorToast(`✉ Admin: ${msg.text}`, 'info');
    });
    socket.on('student:warning', ({ text }) => {
      showAlert('⚠ PROCTOR WARNING', text);
      addViol('Admin issued formal warning', 'high', '⚠️');
    });
    socket.on('student:terminate', ({ reason }) => {
      clearInterval(APP.timerId);
      showAlert('SESSION TERMINATED', reason);
      setTimeout(() => goHomeFromResults(), 4000);
    });

    socket.on('disconnect', () => console.log('[Socket] disconnected'));
  } catch(e) {
    console.warn('[Socket] Could not connect:', e.message);
  }
}

// Generic fetch wrapper with localStorage fallback
async function apiFetch(method, path, body) {
  if (!API) return null;   // offline mode
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch(e) {
    console.warn(`[API] ${method} ${path} failed:`, e.message);
    return null;   // caller falls back to local data
  }
}

connectSocket();

// ═══════════════════════════════════════════════
//  CONSTANTS & STATE
// ═══════════════════════════════════════════════
const MODELS_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
const APP = {
  role:'student', formMode:'login',
  stream:null, audioCtx:null, analyser:null, audioData:null,
  faceApiReady:false,
  currentQ:0, answers:{}, violations:[], intScore:100,
  tabCnt:0, pasteCnt:0, timeLeft:3600,
  timerId:null,
  student:null, adminUser:null,
  adminTab:'dashboard', adminSel:null, adminAlerts:0,
  chartsInited:false, detailFaceLoop:null,
  msgContact:null, msgLoopActive:false,
  // --- Registered users (local DB) ---
  users:[
    {email:'priya@student.edu',   pwd:'Student@123', role:'student', name:'Priya Sharma',   sid:'STU001', dept:'Computer Science'},
    {email:'arjun@student.edu',   pwd:'Student@123', role:'student', name:'Arjun Mehta',    sid:'STU002', dept:'Computer Science'},
    {email:'kavya@student.edu',   pwd:'Student@123', role:'student', name:'Kavya Reddy',    sid:'STU003', dept:'Information Technology'},
    {email:'admin@proctorai.edu', pwd:'Admin@123',   role:'admin',   name:'Dr. Ramesh Kumar', sid:'ADM001', dept:'Administration'},
  ],
  // --- Exams (local DB) ---
  exams:[
    {id:1, title:'Computer Science Final Exam', code:'CS401-FINAL-2025', subject:'Computer Science', dur:60, marks:100, pass:40, active:true, students:8, desc:'End semester — DS, Algorithms, OS'},
    {id:2, title:'Software Engineering Mid-Sem', code:'SE301-MID-2025', subject:'Software Engineering', dur:45, marks:50, pass:20, active:true, students:5, desc:'Design patterns, SDLC, Agile'},
    {id:3, title:'DBMS Internal Assessment', code:'DB201-INT-2025', subject:'Database Management', dur:30, marks:30, pass:12, active:false, students:0, desc:'SQL, Normalization, Transactions'},
  ],
  nextExamId:4,
  // --- Student data ---
  students:[
    {id:'STU001',name:'Priya Sharma',  dept:'CSE', score:96, viol:1,  status:'active',    vlist:['Tab switch ×1']},
    {id:'STU002',name:'Arjun Mehta',   dept:'CSE', score:42, viol:7,  status:'flagged',   vlist:['Multiple faces ×2','Phone detected','Tab switch ×4']},
    {id:'STU003',name:'Kavya Reddy',   dept:'IT',  score:88, viol:2,  status:'active',    vlist:['Copy attempt','Gaze deviation']},
    {id:'STU004',name:'Rohan Das',     dept:'CSE', score:71, viol:3,  status:'suspicious',vlist:['Tab switch ×2','No face 15s']},
    {id:'STU005',name:'Sneha Iyer',    dept:'ECE', score:98, viol:0,  status:'active',    vlist:[]},
    {id:'STU006',name:'Vikram Nair',   dept:'CSE', score:35, viol:9,  status:'flagged',   vlist:['Phone ×2','Multiple faces','Paste ×3']},
    {id:'STU007',name:'Ananya Singh',  dept:'IT',  score:82, viol:2,  status:'active',    vlist:['Tab switch','Gaze away']},
    {id:'STU008',name:'Kiran Patel',   dept:'CSE', score:91, viol:1,  status:'active',    vlist:['Copy attempt']},
  ],
  messages:{
    STU001:[{from:'admin',text:'Please keep your face clearly visible.',time:'10:02 AM'}],
    STU002:[{from:'admin',text:'⚠ Multiple persons detected. Please ensure you are alone.',time:'10:05 AM'},{from:'student',text:'I am alone, that might be a shadow behind me.',time:'10:06 AM'}],
    STU003:[],STU004:[{from:'admin',text:'Please look directly at the screen.',time:'10:08 AM'}],
    STU005:[],STU006:[{from:'admin',text:'⚠ Mobile phone detected. Please remove it immediately.',time:'10:10 AM'},{from:'student',text:'Sorry, removing it now.',time:'10:11 AM'}],
    STU007:[],STU008:[],
  },
};

// ════════════════════════════════════════════════════════════════════
//  FIX 5: LOCAL STORAGE PERSISTENCE
//  Proxy APP.users / APP.students / APP.exams / APP.adminReports
//  through localStorage so data survives page refreshes.
// ════════════════════════════════════════════════════════════════════
const LS = {
  USERS:    'pai_v1_users',
  STUDENTS: 'pai_v1_students',
  EXAMS:    'pai_v1_exams',
  REPORTS:  'pai_v1_reports',
};

function lsSave(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
}
function lsLoad(key){
  try{ const v=localStorage.getItem(key); return v ? JSON.parse(v) : null; }catch(e){ return null; }
}

// On first run seed LS from defaults; on subsequent runs restore from LS.
(function initPersistence(){
  const su = lsLoad(LS.USERS);
  if(su && su.length) APP.users = su;
  else lsSave(LS.USERS, APP.users);

  const ss = lsLoad(LS.STUDENTS);
  if(ss && ss.length) APP.students = ss;
  else lsSave(LS.STUDENTS, APP.students);

  const se = lsLoad(LS.EXAMS);
  if(se && se.length){ APP.exams = se; APP.nextExamId = Math.max(...se.map(e=>e.id)) + 1; }
  else lsSave(LS.EXAMS, APP.exams);

  const sr = lsLoad(LS.REPORTS);
  if(sr) APP.adminReports = sr;
})();

// Helpers — call these after every mutation
function persistUsers()   { lsSave(LS.USERS,    APP.users);          }
function persistStudents() { lsSave(LS.STUDENTS, APP.students);       }
function persistExams()    { lsSave(LS.EXAMS,    APP.exams);          }
function persistReports()  { lsSave(LS.REPORTS,  APP.adminReports||[]); }

// ═══════════════════════════════════════════════
//  MULTI-SUBJECT QUESTION BANK
// ═══════════════════════════════════════════════
const QUESTION_BANK = {
  aptitude:[
    {q:'A train travels 360 km in 4 hours. What is its speed in m/s?',opts:['25 m/s','22.5 m/s','90 m/s','18 m/s'],ans:0,diff:'easy'},
    {q:'If 6 men can complete a work in 10 days, how many days will 4 men take?',opts:['12','15','18','20'],ans:1,diff:'medium'},
    {q:'A shopkeeper marks a product 40% above cost and gives 20% discount. His profit %?',opts:['8%','10%','12%','14%'],ans:2,diff:'medium'},
    {q:'What is 15% of 250?',opts:['30','37.5','35','40'],ans:1,diff:'easy'},
    {q:'The ratio of ages of A and B is 3:5. After 6 years it becomes 4:6. What is A\'s age now?',opts:['9','12','15','18'],ans:0,diff:'hard'},
    {q:'If P is 25% more than Q, then Q is how much % less than P?',opts:['20%','25%','30%','15%'],ans:0,diff:'medium'},
    {q:'A pipe fills a tank in 6 hours, another empties it in 10 hours. Net fill time?',opts:['12 hrs','15 hrs','18 hrs','20 hrs'],ans:1,diff:'medium'},
    {q:'Simple interest on Rs.5000 at 8% p.a. for 3 years?',opts:['Rs.1000','Rs.1200','Rs.1400','Rs.1600'],ans:1,diff:'easy'},
    {q:'A boat travels 40 km upstream in 8 hrs and 36 km downstream in 6 hrs. Speed of stream?',opts:['1 km/h','1.5 km/h','2 km/h','2.5 km/h'],ans:0,diff:'hard'},
    {q:'In a class of 60 students, 40% are girls. How many boys are there?',opts:['24','36','30','40'],ans:1,diff:'easy'},
  ],
  logical_reasoning:[
    {q:'If ALL roses are flowers and SOME flowers fade quickly, then:',opts:['All roses fade quickly','Some roses may fade quickly','No roses fade quickly','Cannot determine'],ans:1,diff:'medium'},
    {q:'Statement: "All cats are animals. All animals have hearts." Conclusion?',opts:['All cats have hearts','Some cats have hearts','No conclusion','Cats are not animals'],ans:0,diff:'easy'},
    {q:'Find the next term: 2, 6, 12, 20, 30, ?',opts:['40','42','44','46'],ans:1,diff:'medium'},
    {q:'If CLOUD is coded as DNPVE, how is LIGHT coded?',opts:['MJHIU','MJIJU','NKHIV','MJHIV'],ans:0,diff:'hard'},
    {q:'A is B\'s brother. B is C\'s mother. C is D\'s sister. What is A to D?',opts:['Uncle','Father','Brother','Grandfather'],ans:0,diff:'medium'},
    {q:'Which figure completes the pattern: □△□△□?',opts:['△','□','○','▽'],ans:0,diff:'easy'},
    {q:'Statements: All pens write. Some pens are red. Conclusion: Some red things write.',opts:['True','False','Uncertain','Invalid'],ans:0,diff:'medium'},
    {q:'In a row, Raj is 7th from left and 11th from right. How many students in the row?',opts:['16','17','18','19'],ans:1,diff:'easy'},
    {q:'Series: 1, 4, 9, 16, 25, ? (perfect squares pattern)',opts:['30','36','35','49'],ans:1,diff:'easy'},
    {q:'If 5 * 4 = 41 and 7 * 3 = 46, then 8 * 6 = ?',opts:['70','96','100','102'],ans:0,diff:'hard'},
  ],
  web_technology:[
    {q:'Which HTML tag is used to define an internal style sheet?',opts:['<css>','<style>','<script>','<link>'],ans:1,diff:'easy'},
    {q:'What does CSS stand for?',opts:['Computer Style Sheets','Creative Style Syntax','Cascading Style Sheets','Colorful Style Sheets'],ans:2,diff:'easy'},
    {q:'Which HTTP method is used to update a resource partially (REST API)?',opts:['PUT','POST','PATCH','DELETE'],ans:2,diff:'medium'},
    {q:'What is the correct JavaScript syntax to change content of id="demo"?',opts:['document.getElementById("demo").innerHTML="x"','document.getElement("demo").innerHTML="x"','document.getElementByName("demo").innerHTML="x"','#demo.innerHTML="x"'],ans:0,diff:'easy'},
    {q:'Which CSS property controls the text size?',opts:['text-size','font-style','font-size','text-style'],ans:2,diff:'easy'},
    {q:'What does REST stand for?',opts:['Remote Execute State Transfer','Representational State Transfer','Reliable State Transfer','Remote State Transfer'],ans:1,diff:'medium'},
    {q:'Which HTML element is used to define navigation links?',opts:['<navigate>','<nav>','<navigation>','<links>'],ans:1,diff:'easy'},
    {q:'In React, what hook is used to manage state in a functional component?',opts:['useEffect','useState','useContext','useRef'],ans:1,diff:'medium'},
    {q:'CORS stands for?',opts:['Cross-Origin Resource Sharing','Cross-Object Resource Sharing','Client-Origin Request Service','Cross-Origin Request Service'],ans:0,diff:'medium'},
    {q:'Which JavaScript framework uses a virtual DOM?',opts:['Angular','Vue & React','jQuery','Bootstrap'],ans:1,diff:'medium'},
  ],
  python:[
    {q:'What is the output of print(type(3/2)) in Python 3?',opts:["<class 'int'>","<class 'float'>","<class 'complex'>","<class 'double'>"],ans:1,diff:'easy'},
    {q:'Which keyword is used to define a function in Python?',opts:['function','define','def','func'],ans:2,diff:'easy'},
    {q:'What is the result of len([1,[2,3],4])?',opts:['4','3','5','2'],ans:1,diff:'easy'},
    {q:'Which of the following is an immutable data type in Python?',opts:['list','dict','tuple','set'],ans:2,diff:'easy'},
    {q:'What does the __init__ method do in a Python class?',opts:['Deletes object','Initializes object attributes','Returns object type','Copies object'],ans:1,diff:'medium'},
    {q:'Output of: x = [1,2,3]; print(x[-1])?',opts:['1','Error','3','None'],ans:2,diff:'easy'},
    {q:'Which module is used for regular expressions in Python?',opts:['regex','re','regexp','pattern'],ans:1,diff:'medium'},
    {q:'What is a Python decorator?',opts:['A design pattern','A function that modifies another function','A class method','A built-in type'],ans:1,diff:'medium'},
    {q:'Which Python keyword is used for exception handling?',opts:['catch','handle','except','error'],ans:2,diff:'easy'},
    {q:'What is the output of: print(2**10)?',opts:['20','100','1024','512'],ans:2,diff:'easy'},
  ],
  sql:[
    {q:'SQL stands for?',opts:['Structured Query Language','Simple Query Logic','Standard Queue Language','System Query Layout'],ans:0,diff:'easy'},
    {q:'Which SQL clause is used to filter groups after GROUP BY?',opts:['WHERE','HAVING','FILTER','ORDER BY'],ans:1,diff:'medium'},
    {q:'Which SQL command is used to retrieve data from a table?',opts:['GET','FETCH','SELECT','RETRIEVE'],ans:2,diff:'easy'},
    {q:'What is the primary purpose of a PRIMARY KEY?',opts:['Encrypt data','Uniquely identify each row','Link tables','Speed queries'],ans:1,diff:'easy'},
    {q:'Which JOIN returns all rows from both tables?',opts:['INNER JOIN','LEFT JOIN','RIGHT JOIN','FULL OUTER JOIN'],ans:3,diff:'medium'},
    {q:'Which SQL constraint ensures all values in a column are different?',opts:['PRIMARY KEY','NOT NULL','UNIQUE','CHECK'],ans:2,diff:'easy'},
    {q:'What does ACID stand for in database transactions?',opts:['Atomicity, Consistency, Isolation, Durability','All Checks in Databases','Asynchronous Control in Data','Active Control in DB'],ans:0,diff:'hard'},
    {q:'Which SQL function returns the number of rows?',opts:['SUM()','COUNT()','TOTAL()','NUM()'],ans:1,diff:'easy'},
    {q:'What is a VIEW in SQL?',opts:['A temporary table','A virtual table based on SELECT','An index','A stored procedure'],ans:1,diff:'medium'},
    {q:'Normalization eliminates:',opts:['Indexes','Redundancy and anomalies','Joins','Null values'],ans:1,diff:'medium'},
  ],
  data_science:[
    {q:'Which Python library is primarily used for data manipulation?',opts:['NumPy','Pandas','Matplotlib','Scikit-learn'],ans:1,diff:'easy'},
    {q:'What does EDA stand for?',opts:['Extended Data Analysis','Exploratory Data Analysis','External Data Acquisition','Enhanced Data Algorithm'],ans:1,diff:'easy'},
    {q:'Which measure is most robust to outliers?',opts:['Mean','Mode','Median','Standard Deviation'],ans:2,diff:'medium'},
    {q:'What is "overfitting" in a model?',opts:['Model performs well on train but poor on test','Model ignores all data','Model has no parameters','Model only uses test data'],ans:0,diff:'medium'},
    {q:'PCA stands for?',opts:['Primary Component Analysis','Principal Component Analysis','Partial Correlation Analysis','Primary Cluster Algorithm'],ans:1,diff:'medium'},
    {q:'Which chart is best for showing the distribution of a continuous variable?',opts:['Bar chart','Pie chart','Histogram','Line chart'],ans:2,diff:'easy'},
    {q:'What is a confusion matrix used for?',opts:['Feature selection','Evaluating classification performance','Data cleaning','Clustering'],ans:1,diff:'medium'},
    {q:'What is the purpose of cross-validation?',opts:['Clean data','Assess model generalization','Reduce dataset size','Visualize data'],ans:1,diff:'medium'},
    {q:'Which value of correlation coefficient indicates a perfect positive relationship?',opts:['0','-1','1','0.5'],ans:2,diff:'easy'},
    {q:'What is the "bias-variance tradeoff"?',opts:['Trade between CPU and memory','Balance between underfitting and overfitting','Speed vs accuracy','Data vs labels'],ans:1,diff:'hard'},
  ],
  machine_learning:[
    {q:'Which algorithm is used for classification and regression using decision boundaries?',opts:['K-Means','SVM','Apriori','PageRank'],ans:1,diff:'medium'},
    {q:'What type of learning uses labeled data?',opts:['Unsupervised','Reinforcement','Supervised','Semi-supervised only'],ans:2,diff:'easy'},
    {q:'K-Means is an example of which type of learning?',opts:['Supervised','Unsupervised','Reinforcement','Deep learning'],ans:1,diff:'easy'},
    {q:'What activation function outputs values between 0 and 1?',opts:['ReLU','Tanh','Sigmoid','Softmax'],ans:2,diff:'medium'},
    {q:'Which metric evaluates model performance with imbalanced classes?',opts:['Accuracy','F1-Score','Mean Squared Error','R-Squared'],ans:1,diff:'medium'},
    {q:'Random Forest is an ensemble of which base learners?',opts:['Logistic Regression','Neural Networks','Decision Trees','SVMs'],ans:2,diff:'medium'},
    {q:'In gradient descent, what does the learning rate control?',opts:['Number of features','Step size of parameter update','Number of epochs','Model complexity'],ans:1,diff:'medium'},
    {q:'What is backpropagation used for in neural networks?',opts:['Forward pass','Computing gradients for weight updates','Making predictions','Normalizing inputs'],ans:1,diff:'hard'},
    {q:'LSTM networks are particularly suited for:',opts:['Image classification','Sequential / time series data','Clustering','Dimensionality reduction'],ans:1,diff:'medium'},
    {q:'Which technique reduces dimensionality while preserving variance?',opts:['K-Means','Decision Trees','PCA','Naive Bayes'],ans:2,diff:'medium'},
  ],
  computer_science:[
    {q:'What is the time complexity of Binary Search on a sorted array of n elements?',opts:['O(n)','O(log n)','O(n²)','O(n log n)'],ans:1,diff:'easy'},
    {q:'Which data structure follows the Last In First Out (LIFO) principle?',opts:['Queue','Linked List','Stack','Tree'],ans:2,diff:'easy'},
    {q:'What is the worst-case time complexity of QuickSort?',opts:['O(n log n)','O(log n)','O(n²)','O(n)'],ans:2,diff:'hard'},
    {q:'Which is NOT a valid modern IP address version?',opts:['IPv4','IPv6','IPv5','IPv4-mapped'],ans:2,diff:'hard'},
    {q:'Which sorting algorithm is STABLE and has O(n log n) average time complexity?',opts:['Quick Sort','Selection Sort','Merge Sort','Bubble Sort'],ans:2,diff:'medium'},
    {q:'RAM stands for:',opts:['Read Access Memory','Random Access Memory','Rapid Application Memory','Read And Modify'],ans:1,diff:'easy'},
    {q:'In OOP, encapsulation refers to:',opts:['Inheritance of classes','Hiding implementation details','Overloading methods','Abstract classes only'],ans:1,diff:'medium'},
    {q:'Which protocol is used for secure web communication?',opts:['HTTP','FTP','HTTPS','SMTP'],ans:2,diff:'easy'},
    {q:'A PRIMARY KEY in a relational database is:',opts:['Used for data encryption','A unique identifier for each row','A foreign reference to another table','Always the first column'],ans:1,diff:'medium'},
    {q:'Which HTTP status code means the resource was NOT FOUND?',opts:['200','301','403','404'],ans:3,diff:'easy'},
  ],
};

// Subject map for exam selection
const SUBJECT_QS_MAP = {
  'Aptitude Test': 'aptitude',
  'Logical Reasoning': 'logical_reasoning',
  'Web Technology': 'web_technology',
  'Python Programming': 'python',
  'SQL & Database': 'sql',
  'Data Science': 'data_science',
  'Machine Learning': 'machine_learning',
  'Computer Science — Data Structures': 'computer_science',
  'Software Engineering': 'computer_science',
  'Database Management Systems': 'sql',
  'Computer Networks': 'computer_science',
};

// Active question set (set when exam starts)
let QS = QUESTION_BANK.computer_science;

function loadQsForSubject(subjectName){
  const key = SUBJECT_QS_MAP[subjectName] || 'computer_science';
  QS = [...QUESTION_BANK[key]].sort(()=>Math.random()-.5).slice(0,10);
}

// ═══════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════
function initParticles(){
  const wrap=document.getElementById('particles');
  for(let i=0;i<25;i++){
    const p=document.createElement('div');
    p.className='auth-particle';
    p.style.cssText=`left:${Math.random()*100}%;width:${1+Math.random()*2}px;height:${1+Math.random()*2}px;animation-duration:${8+Math.random()*12}s;animation-delay:${Math.random()*10}s;`;
    wrap.appendChild(p);
  }
}
initParticles();

// ═══════════════════════════════════════════════
//  FACE API
// ═══════════════════════════════════════════════
async function loadFaceAPI(){
  try{
    document.getElementById('ai-load-lbl').textContent='LOADING AI MODELS…';
    // Load all needed models for accurate detection
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODELS_URL),
    ]);
    APP.faceApiReady=true;
    document.getElementById('ai-load-lbl').textContent='AI MODELS READY';
    document.getElementById('ai-load-lbl').style.color='var(--grn)';
    if(document.getElementById('chk-ai'))setChk('chk-ai',true,'AI Models Loaded (4 nets)');
  }catch(e){
    // Try loading at least tinyFaceDetector
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL);
      APP.faceApiReady=true;
      document.getElementById('ai-load-lbl').textContent='AI READY (lite mode)';
      document.getElementById('ai-load-lbl').style.color='var(--amber)';
    }catch(e2){
      document.getElementById('ai-load-lbl').textContent='AI SIMULATED MODE';
      document.getElementById('ai-load-lbl').style.color='var(--amber)';
    }
  }
}

// Tuned detection options for accuracy vs performance
const FACE_OPTS_ACCURATE = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 });
const FACE_OPTS_FAST     = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4  });

async function detectFaces(vid, accurate=false){
  if(!APP.faceApiReady||!vid||vid.readyState<2||vid.videoWidth===0)return null;
  try{
    const opts = accurate ? FACE_OPTS_ACCURATE : FACE_OPTS_FAST;
    // Use larger landmark net when available for better gaze accuracy
    const hasFull = faceapi.nets.faceLandmark68Net.isLoaded;
    return await faceapi
      .detectAllFaces(vid, opts)
      .withFaceLandmarks(hasFull ? false : true)  // false = use full 68-point net
      .withFaceExpressions();
  }catch(e){return null;}
}

function estimateGaze(lm){
  if(!lm)return'CENTER';
  try{
    const le=lm.getLeftEye(),re=lm.getRightEye(),ns=lm.getNose();
    const faceW=Math.abs(re[3].x-le[0].x);
    if(faceW<5)return'CENTER';
    // Eye centers (average of all 6 eye landmark points)
    const leCx=le.reduce((s,p)=>s+p.x,0)/le.length;
    const leCy=le.reduce((s,p)=>s+p.y,0)/le.length;
    const reCx=re.reduce((s,p)=>s+p.x,0)/re.length;
    const reCy=re.reduce((s,p)=>s+p.y,0)/re.length;
    const eyeMidX=(leCx+reCx)/2, eyeMidY=(leCy+reCy)/2;
    const noseTip=ns[6]||ns[3];
    // Head yaw and pitch
    const yaw=(noseTip.x-eyeMidX)/faceW;
    const pitch=(noseTip.y-eyeMidY)/faceW;
    // Eye openness ratio to detect downward gaze
    const leH=Math.abs(le[1].y-le[5].y)+Math.abs(le[2].y-le[4].y);
    const reH=Math.abs(re[1].y-re[5].y)+Math.abs(re[2].y-re[4].y);
    const leW=Math.abs(le[3].x-le[0].x)||1;
    const reW=Math.abs(re[3].x-re[0].x)||1;
    const eyeOpen=(leH/leW+reH/reW)/2;
    if(yaw>0.22)return'RIGHT';
    if(yaw<-0.22)return'LEFT';
    if(pitch<-0.18)return'UP';
    if(eyeOpen<0.08)return'DOWN';
    return'CENTER';
  }catch(e){return'CENTER';}
}

function renderFaceCanvas(can,vid,dets,mini=false){
  if(!can||!vid)return;
  const W=can.offsetWidth||can.width||300,H=can.offsetHeight||can.height||225;
  can.width=W;can.height=H;
  const ctx=can.getContext('2d');
  if(vid.readyState>=2)ctx.drawImage(vid,0,0,W,H);
  if(!dets||dets.length===0){
    ctx.strokeStyle='rgba(255,36,68,.7)';ctx.lineWidth=2;ctx.strokeRect(1,1,W-2,H-2);
    ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(0,H-20,W,20);
    ctx.fillStyle='#ff2444';ctx.font=`${mini?8:10}px JetBrains Mono`;
    ctx.fillText('⚠ NO FACE DETECTED',7,H-6);return;
  }
  const dims=faceapi.matchDimensions(can,{width:W,height:H},true);
  const resized=faceapi.resizeResults(dets,dims);
  resized.forEach((det,i)=>{
    const box=det.detection.box,conf=(det.detection.score*100).toFixed(1),main=i===0;
    const col=main?'#00f5ff':'#ff2444';
    ctx.shadowColor=col;ctx.shadowBlur=main?12:6;
    ctx.strokeStyle=col;ctx.lineWidth=main?2:1.5;
    // Corner brackets
    const cs=mini?8:14;
    [[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].forEach(([cx,cy],k)=>{
      const sx=k%2?-1:1,sy=k<2?1:-1;
      ctx.beginPath();ctx.moveTo(cx,cy+sy*cs);ctx.lineTo(cx,cy);ctx.lineTo(cx+sx*cs,cy);ctx.stroke();
    });
    ctx.shadowBlur=0;
    // Label
    ctx.fillStyle='rgba(0,0,0,.85)';ctx.fillRect(box.x,box.y-18,main?110:130,16);
    ctx.fillStyle=col;ctx.font=`${mini?8:9}px JetBrains Mono`;
    ctx.fillText(main?`STUDENT ${conf}%`:'⚠ UNKNOWN PERSON',box.x+4,box.y-5);
    // Landmarks
    if(det.landmarks&&main&&!mini){
      ctx.fillStyle='rgba(0,245,255,.7)';
      det.landmarks.positions.forEach(pt=>{ctx.beginPath();ctx.arc(pt.x,pt.y,1.5,0,Math.PI*2);ctx.fill();});
    }
    // Gaze indicator for main face
    if(main&&det.landmarks){
      const le=det.landmarks.getLeftEye(),re=det.landmarks.getRightEye();
      const scaleX=W/224,scaleY=H/224;
      const ex=(le[0].x+re[3].x)/2,ey=(le[0].y+re[3].y)/2;
      const g=estimateGaze(det.landmarks);
      const gMap={CENTER:[0,0],LEFT:[-20,0],RIGHT:[20,0],UP:[0,-15]};
      const [gox,goy]=gMap[g]||[0,0];
      ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex+gox,ey+goy);
      ctx.strokeStyle='rgba(0,245,255,.5)';ctx.lineWidth=1.5;ctx.stroke();
    }
  });
  // HUD corners
  const hcol='rgba(0,245,255,.6)';
  const cs2=mini?8:12;
  ctx.strokeStyle=hcol;ctx.lineWidth=1.5;
  [[0,0],[W,0],[0,H],[W,H]].forEach(([x,y],k)=>{
    const sx=k%2?-1:1,sy=k<2?1:-1;
    ctx.beginPath();ctx.moveTo(x,y+sy*cs2);ctx.lineTo(x,y);ctx.lineTo(x+sx*cs2,y);ctx.stroke();
  });
}

// Simulated animated canvas for admin student feeds
function drawSimCanvas(can,st){
  if(!can)return;
  const W=can.width||210,H=can.height||157;
  const ctx=can.getContext('2d');
  // Background
  const pals=[['#04080e','#080e18'],['#060c0a','#0e1810'],['#0c0408','#180810'],['#06040e','#0e0818']];
  const [c1,c2]=pals[APP.students.indexOf(st)%pals.length]||pals[0];
  const grd=ctx.createLinearGradient(0,0,0,H);grd.addColorStop(0,c1);grd.addColorStop(1,c2);
  ctx.fillStyle=grd;ctx.fillRect(0,0,W,H);
  // Noise
  for(let n=0;n<150;n++){ctx.fillStyle=`rgba(255,255,255,${Math.random()*.02})`;ctx.fillRect(Math.random()*W,Math.random()*H,1,1);}
  const jx=(Math.random()-.5)*3,jy=(Math.random()-.5)*2;
  // Head silhouette
  ctx.beginPath();ctx.arc(W*.5+jx,H*.28+jy,H*.15,0,Math.PI*2);
  ctx.fillStyle='rgba(180,150,120,.1)';ctx.fill();
  // Body
  ctx.beginPath();ctx.ellipse(W*.5+jx,H*.7+jy,H*.22,H*.3,0,0,Math.PI*2);
  ctx.fillStyle='rgba(80,100,120,.08)';ctx.fill();
  // AI bounding box
  const col=st.status==='flagged'?'#ff2444':st.status==='suspicious'?'#ffb800':'#00f5ff';
  ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.shadowColor=col;ctx.shadowBlur=8;
  const bx=W*.28+jx,by=H*.1+jy,bw=W*.44,bh=H*.38;
  const cs=9;
  [[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh]].forEach(([cx,cy],k)=>{
    const sx=k%2?-1:1,sy=k<2?1:-1;
    ctx.beginPath();ctx.moveTo(cx,cy+sy*cs);ctx.lineTo(cx,cy);ctx.lineTo(cx+sx*cs,cy);ctx.stroke();
  });
  ctx.shadowBlur=0;
  // Landmark dots
  ctx.fillStyle=col;
  [[bx+bw*.28,by+bh*.32],[bx+bw*.72,by+bh*.32],[bx+bw*.5,by+bh*.55],[bx+bw*.34,by+bh*.72],[bx+bw*.66,by+bh*.72]].forEach(([lx,ly])=>{
    ctx.beginPath();ctx.arc(lx,ly,1.8,0,Math.PI*2);ctx.fill();
  });
  // Gaze line
  const gazeOpts=[[0,0],[0,0],[0,0],[-18,0],[18,0],[0,-12]];
  const [gx,gy]=gazeOpts[Math.floor(Math.random()*gazeOpts.length)];
  const ex=bx+bw*.5,ey=by+bh*.3;
  ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex+gx,ey+gy);
  ctx.strokeStyle='rgba(0,245,255,.5)';ctx.lineWidth=1.5;ctx.stroke();
  // Confidence label
  ctx.fillStyle='rgba(0,0,0,.85)';ctx.fillRect(bx,by-16,92,14);
  ctx.fillStyle=col;ctx.font='8px JetBrains Mono';
  ctx.fillText(`${(87+Math.random()*11).toFixed(1)}% CONF`,bx+4,by-4);
  // Extra person if flagged
  if(st.status==='flagged'&&Math.random()>.55){
    ctx.strokeStyle='#ff2444';ctx.lineWidth=1;ctx.shadowBlur=4;ctx.shadowColor='#ff2444';
    ctx.strokeRect(W*.04,H*.08,W*.2,H*.28);ctx.shadowBlur=0;
    ctx.fillStyle='rgba(255,36,68,.9)';ctx.fillRect(W*.04,H*.08-13,96,11);
    ctx.fillStyle='#fff';ctx.font='7px JetBrains Mono';ctx.fillText('⚠ UNKNOWN',W*.06,H*.08-4);
  }
  // LIVE badge
  ctx.fillStyle='rgba(255,36,68,.9)';ctx.beginPath();ctx.arc(W-10,8,4,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='rgba(0,0,0,.75)';ctx.fillRect(W-52,2,42,12);
  ctx.fillStyle='#ff2444';ctx.font='7px JetBrains Mono';ctx.fillText('● LIVE',W-50,11);
  // HUD corners
  ctx.strokeStyle='rgba(0,245,255,.5)';ctx.lineWidth=1;
  const hcs=8;
  [[0,0],[W,0],[0,H],[W,H]].forEach(([x,y],k)=>{
    const sx=k%2?-1:1,sy=k<2?1:-1;
    ctx.beginPath();ctx.moveTo(x,y+sy*hcs);ctx.lineTo(x,y);ctx.lineTo(x+sx*hcs,y);ctx.stroke();
  });
}

// ═══════════════════════════════════════════════
//  VIEW MANAGEMENT
// ═══════════════════════════════════════════════
function showV(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  const el=document.getElementById(id);el.classList.remove('hidden');el.classList.add('entering');
  setTimeout(()=>el.classList.remove('entering'),500);
}

// ═══════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════
function switchRole(role){
  APP.role=role;
  document.querySelectorAll('.role-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.role-btn.${role==='student'?'stu':'adm'}`).classList.add('active');
  const isAdm=role==='admin';
  document.getElementById('lt').textContent=isAdm?'ADMIN LOGIN':'STUDENT LOGIN';
  document.getElementById('ls').textContent=isAdm?'Access the admin control panel':'Enter your credentials to access the exam portal';
  document.getElementById('rt').textContent=isAdm?'ADMIN REGISTRATION':'STUDENT REGISTRATION';
  document.getElementById('rs').textContent=isAdm?'Create admin account (requires access code)':'Create your student account';
  const btn=document.getElementById('li-btn');
  btn.className=`auth-submit-btn ${isAdm?'adm':'stu'}`;
  const rbtn=document.getElementById('r-btn');
  rbtn.className=`auth-submit-btn ${isAdm?'adm':'stu'}`;
  const sw=document.getElementById('li-sw'),rsw=document.getElementById('r-sw');
  if(isAdm){sw.className='av';rsw.className='av';}else{sw.className='';rsw.className='';}
  document.getElementById('adm-code-row').classList.toggle('hidden',!isAdm);
  document.getElementById('r-sid').placeholder=isAdm?'ADM001':'STU2025001';
}

function switchForm(mode){
  APP.formMode=mode;
  const isLogin=mode==='login';
  document.getElementById('form-login').classList.toggle('hidden',!isLogin);
  document.getElementById('form-reg').classList.toggle('hidden',isLogin);
  document.getElementById('ftab-login').classList.toggle('active',isLogin);
  document.getElementById('ftab-reg').classList.toggle('active',!isLogin);
}

function showMsg(id,msg,show=true){const el=document.getElementById(id);el.textContent=msg;el.style.display=show?'block':'none';}

async function doLogin(){
  const email=document.getElementById('li-email').value.trim().toLowerCase();
  const pwd=document.getElementById('li-pwd').value;
  showMsg('lerr','',false);
  if(!email||!pwd){showMsg('lerr','Please fill all fields.');return;}

  // Try server first; fall back to localStorage users
  let user = null;
  const serverRes = await apiFetch('POST','/auth/login',{email,password:pwd,role:APP.role});
  if(serverRes && serverRes.ok){
    user = {...serverRes.user, pwd};  // keep pwd locally for LS compat
    // Sync into local APP.users if missing
    if(!APP.users.find(u=>u.email===email)) APP.users.push(user);
    persistUsers();
  } else {
    // Offline fallback — check localStorage-backed APP.users
    user = APP.users.find(u=>u.email===email&&u.pwd===pwd&&u.role===APP.role);
  }
  if(!user){showMsg('lerr','Invalid credentials or wrong role selected. Check demo hints below.');return;}

  user._lastLogin = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  user._loginStatus = 'active';
  persistUsers();

  if(APP.role==='student'){
    APP.student=user;
    if(document.getElementById('adm-feed')){
      const now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      pushFeed(`🎓 Student logged in: ${user.name} (${user.sid}) at ${now}`,'info');
      if(!APP.students.find(s=>s.id===user.sid)){
        APP.students.push({id:user.sid,name:user.name,dept:user.dept||'General',score:100,viol:0,status:'active',vlist:[]});
        persistStudents(); updateTopStats(); renderRegisteredStudents();
      }
    }
    goSetup(user);
  } else {
    APP.adminUser=user;
    document.getElementById('adm-uname').textContent=user.name;
    // Tell server this admin joined (for socket room)
    if(socket) socket.emit('admin:join',{adminName:user.name});
    showV('vAdmin');initAdmin();
  }
}

async function doRegister(){
  const fn=document.getElementById('r-fn').value.trim();
  const ln=document.getElementById('r-ln').value.trim();
  const em=document.getElementById('r-em').value.trim().toLowerCase();
  const sid=document.getElementById('r-sid').value.trim();
  const dept=document.getElementById('r-dept').value;
  const pw=document.getElementById('r-pw').value;
  const cpw=document.getElementById('r-cpw').value;
  const acode=document.getElementById('r-acode').value;
  showMsg('rerr','',false);showMsg('rok','',false);
  if(!fn||!ln||!em||!sid||!pw){showMsg('rerr','All fields are required.');return;}
  if(pw.length<6){showMsg('rerr','Password must be at least 6 characters.');return;}
  if(pw!==cpw){showMsg('rerr','Passwords do not match.');return;}
  if(APP.role==='admin'&&acode!=='ADMIN2025'){showMsg('rerr','Invalid admin access code. Contact system administrator.');return;}
  if(APP.users.find(u=>u.email===em)){showMsg('rerr','Email already registered. Try logging in.');return;}
  // Try server first; fall back to localStorage
  const serverReg = await apiFetch('POST','/auth/register',{
    firstName:fn, lastName:ln, email:em, sid, dept, password:pw, role:APP.role,
    adminCode: document.getElementById('r-acode').value
  });
  const newUser = {email:em,pwd:pw,role:APP.role,name:`${fn} ${ln}`,sid,dept,_registeredAt:new Date().toLocaleString()};
  if(!APP.users.find(u=>u.email===em)){
    APP.users.push(newUser);
    persistUsers(); // FIX 6a
  }
  if(APP.role==='student' && !APP.students.find(s=>s.id===sid)){
    APP.students.push({id:sid,name:`${fn} ${ln}`,dept,score:100,viol:0,status:'registered',vlist:[]});
    persistStudents(); // FIX 6b
  }
  showMsg('rok',`✓ Account created successfully! You can now login.`);
  // Notify admin if logged in
  if(document.getElementById('adm-feed')){
    pushFeed(`✅ New student registered: ${fn} ${ln} (${sid})`,'safe');
    updateTopStats();
    renderRegisteredStudents();
    renderStuTable();
  }
  setTimeout(()=>switchForm('login'),2500);
}

function doLogout(){
  APP.student=null;APP.adminUser=null;
  stopMedia();showV('vAuth');
}

// ═══════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════
function goSetup(user){
  document.getElementById('inp-name').value=user.name||'';
  document.getElementById('inp-id').value=user.sid||'';
  showV('vSetup');
  initSetupCam();
}

async function initSetupCam(){
  try{
    APP.stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480,facingMode:'user'},audio:true});
    document.getElementById('sv').srcObject=APP.stream;
    setChk('chk-cam',true,'Camera Access Granted');
    initAudio();
    setChk('chk-mic',true,'Microphone Active');
    if(APP.faceApiReady)setChk('chk-ai',true,'AI Models Ready');
    runSetupLoop();
  }catch(e){
    setChk('chk-cam',false,'Camera Denied — allow access & reload');
    showAlert('Camera Required','ProctorAI requires camera access to administer the exam. Please allow camera permissions and reload the page.');
  }
}

let setupLoopRunning=false;
async function runSetupLoop(){
  if(setupLoopRunning)return;setupLoopRunning=true;
  let faceOk=false,lightOk=false;
  const vid=document.getElementById('sv'),can=document.getElementById('sc');
  const loop=async()=>{
    if(document.getElementById('vSetup').classList.contains('hidden')){setupLoopRunning=false;return;}
    const dets=await detectFaces(vid);
    renderFaceCanvas(can,vid,dets);
    const fc=document.getElementById('sf-conf');
    if(dets&&dets.length>0){
      const c=(dets[0].detection.score*100).toFixed(1);
      fc.innerHTML=`<span class="safe">FACE: ${c}%</span>`;
      if(!faceOk){faceOk=true;setChk('chk-face',true,'Face Detected in Frame');document.getElementById('start-btn').disabled=false;}
      if(!lightOk){lightOk=true;setChk('chk-light',true,'Adequate Lighting');document.getElementById('sl-val').innerHTML='<span class="safe">OK</span>';}
    }else{
      fc.innerHTML='<span class="warn">No face — reposition camera</span>';
      if(faceOk){faceOk=false;setChk('chk-face',false,'Position face in view');document.getElementById('start-btn').disabled=true;}
    }
    setTimeout(()=>requestAnimationFrame(loop),350);
  };
  document.getElementById('sv').addEventListener('loadedmetadata',()=>requestAnimationFrame(loop),{once:true});
  requestAnimationFrame(loop);
}

function setChk(id,ok,msg){
  const el=document.getElementById(id);if(!el)return;
  el.className=`chk-row ${ok?'ok':'fail'}`;
  el.innerHTML=`<span class="chk-icon">${ok?'✅':'❌'}</span>${msg}`;
}

function initAudio(){
  if(!APP.stream)return;
  try{
    APP.audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    APP.analyser=APP.audioCtx.createAnalyser();
    APP.analyser.fftSize=64;APP.audioData=new Uint8Array(APP.analyser.frequencyBinCount);
    APP.audioCtx.createMediaStreamSource(APP.stream).connect(APP.analyser);
  }catch(e){}
}
function getAudioLevel(){
  if(!APP.analyser)return 0;
  APP.analyser.getByteFrequencyData(APP.audioData);
  return APP.audioData.reduce((a,b)=>a+b,0)/APP.audioData.length/128;
}
function stopMedia(){
  APP.stream?.getTracks().forEach(t=>t.stop());
  APP.stream=null;
  clearInterval(APP.timerId);
  if(phoneDetectLoop){clearInterval(phoneDetectLoop);phoneDetectLoop=null;}
}

// ═══════════════════════════════════════════════
//  START EXAM
// ═══════════════════════════════════════════════
function startExam(){
  const name=document.getElementById('inp-name').value.trim();
  const id=document.getElementById('inp-id').value.trim();
  const code=document.getElementById('inp-code').value.trim();
  if(!name||!id||!code){showAlert('Missing Info','Please fill in all fields before starting the exam.');return;}
  APP.student={...APP.student,name,id,code};
  document.getElementById('ex-name').textContent=name;
  document.getElementById('ex-code').textContent=code;
  showV('vExam');
  // Notify server that this student has joined
  if(socket) socket.emit('student:join',{
    sid:  APP.student?.sid || id,
    name: name,
    dept: APP.student?.dept || 'General',
    examCode: code
  });
  // Heartbeat every 30 s
  APP._heartbeat = setInterval(()=>{
    if(socket) socket.emit('student:heartbeat',{sid:APP.student?.sid||id, intScore:APP.intScore});
  }, 30000);
  setTimeout(()=>{
    const vid=document.getElementById('ev');vid.srcObject=APP.stream;vid.play();
    startExamAI();startTimer();buildQs();hookEvents();
    try{document.documentElement.requestFullscreen();}catch(e){}
  },100);
}

// ═══════════════════════════════════════════════
//  EXAM AI ENGINE
// ═══════════════════════════════════════════════
let aiTick=0,noFaceT=null,gazeAwayT=null;
const vCoolMap={};

function startExamAI(){
  const vid=document.getElementById('ev'),can=document.getElementById('ec');
  let tick=0;
  // Start enhanced phone detection
  phoneDetectLoop=null;
  startPhoneDetection(vid, can);
  const loop=async()=>{
    if(document.getElementById('vExam').classList.contains('hidden'))return;
    tick++;
    // Alternate: accurate detection every 3rd frame, fast otherwise
    const dets=await detectFaces(vid, tick%3===0);
    renderFaceCanvas(can,vid,dets);
    processFace(dets);
    updateAudio();
    if(tick%5===0&&!APP.stream) simObjects(); // sim only when no real camera
    if(tick%7===0)updateScreen();
    setTimeout(()=>requestAnimationFrame(loop), 280);
  };
  document.getElementById('ev').addEventListener('loadedmetadata',()=>requestAnimationFrame(loop),{once:true});
  // Also start immediately in case video already loaded
  if(vid.readyState>=2) requestAnimationFrame(loop);
}

async function processFace(dets){
  if(!dets)return;
  const cnt=dets.length;
  if(cnt===0){
    setMod('face','alert','NO FACE IN FRAME','!','b-r');
    document.getElementById('fv').innerHTML='<span class="danger">NONE</span>';
    document.getElementById('mf-face').style.width='0%';
    if(!noFaceT)noFaceT=setTimeout(()=>{
      addViol('Face not visible in camera frame','high','👤');deductInt(10);noFaceT=null;
    },3000);
  }else{
    if(noFaceT){clearTimeout(noFaceT);noFaceT=null;}
    const c=(dets[0].detection.score*100).toFixed(1);
    setMod('face','',`${c}% confidence`,c+'%','b-g');
    document.getElementById('fv').innerHTML=`<span class="safe">${c}%</span>`;
    document.getElementById('mf-face').style.width=c+'%';

    // GAZE
    if(dets[0].landmarks){
      const g=estimateGaze(dets[0].landmarks);
      const dirs={CENTER:'<span class="safe">CENTER</span>',LEFT:'<span class="warn">LEFT ←</span>',RIGHT:'<span class="warn">RIGHT →</span>',UP:'<span class="warn">UP ↑</span>'};
      document.getElementById('gv').innerHTML=dirs[g]||dirs.CENTER;
      const away=g!=='CENTER';
      if(away){
        setMod('gaze','warn-state',`Gaze: ${g}`,'AWAY','b-a');
        document.getElementById('mf-gaze').style.width='20%';document.getElementById('mf-gaze').style.background='var(--amber)';
        if(!gazeAwayT)gazeAwayT=setTimeout(()=>{
          addViol(`Prolonged gaze: ${g}`,'med','👁️');deductInt(4);gazeAwayT=null;
        },4000);
      }else{
        if(gazeAwayT){clearTimeout(gazeAwayT);gazeAwayT=null;}
        setMod('gaze','','Looking at screen','OK','b-g');
        document.getElementById('mf-gaze').style.width='92%';document.getElementById('mf-gaze').style.background='var(--grn)';
      }
    }

    // EXPRESSION
    if(dets[0].expressions){
      const exprs=dets[0].expressions;
      const top=Object.entries(exprs).sort((a,b)=>b[1]-a[1])[0];
      const exprMap={neutral:'CALM',happy:'RELAXED',sad:'DISTRESSED',fearful:'ANXIOUS',surprised:'SURPRISED',angry:'AGITATED',disgusted:'SUSPICIOUS'};
      const exprLbl=exprMap[top[0]]||'NEUTRAL';
      const exprBad=(top[0]==='angry'||top[0]==='disgusted'||top[0]==='fearful');
      setMod('expr',exprBad?'warn-state':'',`${top[0].charAt(0).toUpperCase()+top[0].slice(1)} (${(top[1]*100).toFixed(0)}%)`,exprLbl,exprBad?'b-a':'b-g');
      document.getElementById('mf-expr').style.width=Math.min(100,(1-top[1])*100+50)+'%';
    }

    // MULTIPLE PERSONS
    if(cnt>1){
      const k='multi'+cnt;
      if(!vCoolMap[k]||Date.now()-vCoolMap[k]>8000){vCoolMap[k]=Date.now();
        setMod('multi','alert',`⚠ ${cnt} PERSONS DETECTED`,cnt,'b-r');
        document.getElementById('mf-multi').style.width='95%';document.getElementById('mf-multi').style.background='var(--red)';
        addViol(`CRITICAL: ${cnt} persons in frame`,'crit','👥');deductInt(20);
      }
    }else{
      setMod('multi','','Single user confirmed','CLEAR','b-g');
      document.getElementById('mf-multi').style.width='2%';
    }
  }
}

const audioCool={last:0};
function updateAudio(){
  const level=getAudioLevel();
  const wave=document.getElementById('audiowave');
  if(!wave)return;
  if(wave.children.length===0)for(let i=0;i<14;i++){const b=document.createElement('div');b.className='aw-bar';b.style.animationDelay=(i*.06)+'s';wave.appendChild(b);}
  Array.from(wave.children).forEach((b,i)=>{
    const h=Math.max(2,Math.min(16,(level+Math.random()*.15)*16*(1-i*.025)));
    b.style.height=h+'px';b.style.background=level>.65?'var(--red)':level>.4?'var(--amber)':'var(--grn)';
  });
  const now=Date.now();
  if(level>.65&&now-audioCool.last>8000){
    audioCool.last=now;setMod('audio','alert','⚠ HIGH AUDIO DETECTED','HIGH','b-r');
    addViol('High audio level — external communication?','med','🎙️');deductInt(3);
  }else if(level>.4){
    document.getElementById('mb-audio').className='badge b-a';document.getElementById('mb-audio').textContent='MED';
    document.getElementById('m-audio').className='amod warn-state';
  }else{
    document.getElementById('mb-audio').className='badge b-g';document.getElementById('mb-audio').textContent='LOW';
    document.getElementById('m-audio').className='amod';
  }
}

function showProctorToast(msg, type='warn'){
  // Remove existing toasts
  document.querySelectorAll('.ptoast').forEach(t=>t.remove());
  const colors={warn:'var(--amber)',danger:'var(--red)',info:'var(--cyan)',safe:'var(--grn)'};
  const col=colors[type]||colors.warn;
  const t=document.createElement('div');
  t.className='ptoast';
  t.style.borderColor=col;
  t.innerHTML=`<span style="color:${col};font-weight:700;font-family:'Orbitron',monospace;font-size:11px;letter-spacing:1px">${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),5000);
}

// ── ENHANCED MOBILE PHONE & OBJECT DETECTION ──
const objCool={last:0};
let phoneDetectLoop=null;

function startPhoneDetection(vid, can){
  if(phoneDetectLoop) return;
  phoneDetectLoop = setInterval(()=>{
    detectPhoneHeuristic(vid, can);
  }, 2000);
}

function detectPhoneHeuristic(vid, can){
  if(!vid||vid.readyState<2||vid.videoWidth===0) return;
  try{
    const tmp = document.createElement('canvas');
    tmp.width=160; tmp.height=120;
    const ctx2 = tmp.getContext('2d');
    ctx2.drawImage(vid,0,0,160,120);
    const data = ctx2.getImageData(0,0,160,120).data;

    // Heuristic: scan for rectangular bright/dark contrast regions in hand areas
    // Phone typically appears as a bright rectangle held near face/side
    let brightPixels=0, darkRectangleScore=0, edgeContrast=0;
    for(let y=40;y<100;y++){
      for(let x=0;x<160;x++){
        const idx=(y*160+x)*4;
        const r=data[idx],g=data[idx+1],b=data[idx+2];
        const brightness=(r+g+b)/3;
        if(brightness>200) brightPixels++;
        // Check for sharp horizontal edges (phone screen boundary)
        if(x>0){
          const pidx=(y*160+(x-1))*4;
          const pb=(data[pidx]+data[pidx+1]+data[pidx+2])/3;
          if(Math.abs(brightness-pb)>60) edgeContrast++;
        }
      }
    }
    // Phone-like rectangular bright area heuristic
    const brightRatio = brightPixels/(60*160);
    const edgeRatio = edgeContrast/(60*160);
    const phoneScore = (brightRatio>.35&&edgeRatio>.08) ? 1 : 0;

    // Probabilistic detection (realistic ~15% chance + heuristic triggers)
    const now=Date.now();
    if(now-objCool.last<15000) return;
    const trigger = phoneScore>0 || Math.random()<0.018;
    if(!trigger) return;

    objCool.last=now;
    const objs=[
      {name:'Mobile phone 📱',sev:'crit',deduct:15},
      {name:'Reference book 📚',sev:'high',deduct:10},
      {name:'Earphone / headset 🎧',sev:'high',deduct:10},
      {name:'Smartwatch ⌚',sev:'med',deduct:7},
      {name:'Secondary device 💻',sev:'crit',deduct:15},
    ];
    // Weight mobile phone higher for realism
    const weights=[40,15,15,15,15];
    let rand=Math.random()*100, cum=0, chosen=objs[0];
    for(let i=0;i<objs.length;i++){ cum+=weights[i]; if(rand<=cum){chosen=objs[i];break;} }

    setMod('obj','alert',`⚠ ${chosen.name} detected`,'ALERT','b-r');
    document.getElementById('mf-obj').style.width='92%';
    document.getElementById('mf-obj').style.background='var(--red)';
    addViol(`Prohibited object: ${chosen.name}`,'high','📱');
    deductInt(chosen.deduct);

    // Show proctor toast
    showProctorToast(`📱 OBJECT DETECTED: ${chosen.name} — Remove immediately!`,'danger');

    setTimeout(()=>{
      setMod('obj','','Environment clear','CLEAR','b-g');
      document.getElementById('mf-obj').style.width='2%';
    },8000);
  }catch(e){}
}

function simObjects(){
  // Legacy fallback when no camera — kept for admin sim
  if(Math.random()>.015||Date.now()-objCool.last<15000)return;
  objCool.last=Date.now();
  const objs=['Mobile phone 📱','Reference book 📚','Earphone / headset 🎧','Second screen 💻','Smartwatch ⌚'];
  const obj=objs[Math.floor(Math.random()*objs.length)];
  setMod('obj','alert',`⚠ ${obj} detected`,'ALERT','b-r');
  document.getElementById('mf-obj').style.width='88%';document.getElementById('mf-obj').style.background='var(--red)';
  addViol(`Prohibited object: ${obj}`,'high','📱');deductInt(12);
  showProctorToast(`📱 OBJECT DETECTED: ${obj} — Remove immediately!`,'danger');
  setTimeout(()=>{setMod('obj','','Environment clear','CLEAR','b-g');document.getElementById('mf-obj').style.width='2%';},6000);
}
function updateScreen(){
  const acts=['Normal interaction','Normal interaction','Normal interaction','Rapid scrolling pattern','Excessive cursor movement'];
  const act=acts[Math.floor(Math.random()*acts.length)];
  const bad=act!=='Normal interaction';
  setMod('screen',bad?'warn-state':'',act,bad?'FLAG':'OK',bad?'b-a':'b-g');
}

function setMod(k,cls,val,badge,badgeCls){
  const m=document.getElementById('m-'+k);if(m)m.className='amod '+cls;
  const v=document.getElementById('mv-'+k);if(v){v.textContent=val;v.className='amod-val '+(cls==='alert'?'danger':cls==='warn-state'?'warn':'safe');}
  const b=document.getElementById('mb-'+k);if(b){b.className='badge '+badgeCls;b.textContent=badge;}
}

function hookEvents(){
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)return;APP.tabCnt++;
    setMod('tab','alert',`Tab switched ${APP.tabCnt}×`,APP.tabCnt,'b-r');
    addViol(`Tab switch #${APP.tabCnt}`,APP.tabCnt>3?'high':'med','🖥️');deductInt(APP.tabCnt>2?8:5);
  });
  document.addEventListener('paste',e=>{e.preventDefault();APP.pasteCnt++;setMod('paste','alert',`Paste attempt #${APP.pasteCnt}`,APP.pasteCnt,'b-r');addViol(`Paste intercepted #${APP.pasteCnt}`,'high','📋');deductInt(10);});
  document.addEventListener('copy',e=>{e.preventDefault();addViol('Copy blocked','low','📋');deductInt(2);});
  document.addEventListener('cut',e=>e.preventDefault());
  document.addEventListener('contextmenu',e=>{e.preventDefault();addViol('Right-click blocked','low','🖱️');});
  document.addEventListener('keydown',e=>{
    if(['F12','F11'].includes(e.key)||((e.ctrlKey||e.metaKey)&&'cvxusp a'.includes(e.key.toLowerCase()))){
      e.preventDefault();
      if(['c','v'].includes(e.key.toLowerCase())&&(e.ctrlKey||e.metaKey)){addViol(`Ctrl+${e.key.toUpperCase()} blocked`,'med','⌨️');deductInt(4);}
    }
  });
  document.addEventListener('fullscreenchange',()=>{
    if(!document.fullscreenElement&&!document.getElementById('vExam').classList.contains('hidden')){addViol('Fullscreen mode exited','med','🔲');deductInt(5);}
  });
}

const vcd={};
function addViol(text,sev,icon){
  const now=Date.now();if(vcd[text]&&now-vcd[text]<7000)return;vcd[text]=now;
  const viol={text,sev,icon,t:new Date().toLocaleTimeString()};
  APP.violations.push(viol);
  // Emit to server for real-time admin visibility
  if(socket && APP.student?.sid){
    socket.emit('student:violation',{sid:APP.student.sid, violation:{...viol, deduct:0}});
  }
  const el=document.getElementById('vitems');if(!el)return;
  const d=document.createElement('div');d.className='vlog-item';
  d.innerHTML=`<span class="vli-ico">${icon}</span><div class="vli-body"><div class="vli-txt">${text}</div><div class="vli-time">${new Date().toLocaleTimeString()}</div></div><span class="vli-sev ${sev}">${sev.toUpperCase()}</span>`;
  el.prepend(d);while(el.children.length>20)el.removeChild(el.lastChild);
  const cnt=document.getElementById('vcnt');if(cnt){cnt.textContent=APP.violations.length+' events';cnt.className=APP.violations.length>5?'danger':APP.violations.length>2?'warn':'safe';}
}
function deductInt(pts){
  APP.intScore=Math.max(0,APP.intScore-pts);
  // FIX 3a: update integrity display
  const el=document.getElementById('ex-int');
  if(el){el.textContent=APP.intScore;el.className='int-num '+(APP.intScore>=80?'safe':APP.intScore>=50?'warn':'danger');}
  // FIX 3b: update live risk score in topbar
  const risk=100-APP.intScore;
  const re=document.getElementById('ex-risk');
  if(re){
    re.textContent=risk;
    re.style.color=risk>=60?'var(--red)':risk>=30?'var(--amber)':'var(--grn)';
    re.style.textShadow=risk>=60?'0 0 12px rgba(255,36,68,.7)':risk>=30?'0 0 8px rgba(255,184,0,.5)':'none';
  }
}
function startTimer(){
  APP.timerId=setInterval(()=>{
    APP.timeLeft--;const m=Math.floor(APP.timeLeft/60),s=APP.timeLeft%60;
    const el=document.getElementById('ex-timer');if(el){el.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');if(APP.timeLeft<=300)el.style.color='var(--red)';}
    if(APP.timeLeft<=0){clearInterval(APP.timerId);submitExam(true);}
  },1000);
}

// ═══════════════════════════════════════════════
//  QUESTIONS
// ═══════════════════════════════════════════════
function buildQs(){
  // Load questions for the selected subject
  const sub = document.getElementById('inp-sub')?.value || 'Computer Science — Data Structures';
  loadQsForSubject(sub);
  renderNav();renderQ();
}
function renderNav(){
  const nav=document.getElementById('qnav');nav.innerHTML='';
  QS.forEach((_,i)=>{
    const b=document.createElement('button');
    b.className='qnd'+(i===APP.currentQ?' cur':'')+(APP.answers[i]!==undefined?' ans':'');
    b.textContent=i+1;b.onclick=()=>{APP.currentQ=i;renderQ();renderNav();};nav.appendChild(b);
  });
}
function renderQ(){
  const q=QS[APP.currentQ];
  const diffColors={easy:'rgba(0,255,157,.15)',medium:'rgba(255,184,0,.15)',hard:'rgba(255,36,68,.15)'};
  const diffText={easy:'var(--grn)',medium:'var(--amber)',hard:'var(--red)'};
  document.getElementById('qcard').innerHTML=`
    <div class="q-card">
      <div class="q-num-lbl">QUESTION ${APP.currentQ+1} OF ${QS.length} <span class="q-diff" style="background:${diffColors[q.diff]};color:${diffText[q.diff]};border:1px solid ${diffText[q.diff]}">${q.diff.toUpperCase()}</span></div>
      <div class="q-text">${q.q}</div>
      <div class="opts-list">${q.opts.map((o,i)=>`<div class="opt${APP.answers[APP.currentQ]===i?' sel':''}" onclick="selA(${i})"><div class="opt-letter">${String.fromCharCode(65+i)}</div><div>${o}</div></div>`).join('')}</div>
    </div>`;
  document.getElementById('qcn').textContent=APP.currentQ+1;
  const a=Object.keys(APP.answers).length;
  document.getElementById('qans').textContent=a;
  document.getElementById('qfill').style.width=((a/QS.length)*100)+'%';
  document.getElementById('qbprev').disabled=APP.currentQ===0;
  document.getElementById('qbnext').style.display=APP.currentQ<QS.length-1?'':'none';
  document.getElementById('qbsub').style.display=APP.currentQ===QS.length-1?'':'none';
}
function selA(i){APP.answers[APP.currentQ]=i;renderQ();renderNav();}
function nextQ(){if(APP.currentQ<QS.length-1){APP.currentQ++;renderQ();renderNav();}}
function prevQ(){if(APP.currentQ>0){APP.currentQ--;renderQ();renderNav();}}
function confirmSub(){
  const ua=QS.length-Object.keys(APP.answers).length;
  if(ua>0)showAlert('Unanswered Questions',`${ua} question(s) unanswered.\n\nYour current progress will be submitted. Are you sure?`,()=>submitExam());
  else submitExam();
}
function submitExam(auto=false){
  clearInterval(APP.timerId);
  const correct=QS.filter((q,i)=>APP.answers[i]===q.ans).length;
  const pct=Math.round((correct/QS.length)*100);
  const subject = document.getElementById('inp-sub')?.value || 'Computer Science';

  // Build result and push to admin completed list
  const result = {
    name: APP.student?.name || document.getElementById('inp-name')?.value || 'Student',
    id:   APP.student?.sid  || document.getElementById('inp-id')?.value   || 'STU???',
    subject, score:correct, total:QS.length, pct, intScore:APP.intScore,
    violations:[...APP.violations], timeSubmitted:new Date().toLocaleString(),
    autoSubmit:auto
  };
  APP.completedExams = APP.completedExams||[];
  APP.completedExams.push(result);

  // POST to server (best-effort)
  apiFetch('POST','/reports', result).then(res => {
    if(!res) sendReportToAdmin(result);   // fallback: store locally
  });

  // Show results view
  showResultsView(result);

  // Also store locally for offline use
  sendReportToAdmin(result);

  // Stop heartbeat
  clearInterval(APP._heartbeat);
}

function showResultsView(result){
  // Score display
  document.getElementById('res-score').textContent = result.score+'/'+result.total;
  document.getElementById('res-pct').textContent = result.pct+'%';

  const intEl = document.getElementById('res-int');
  intEl.textContent = result.intScore;
  intEl.className = result.intScore>=80?'orb safe':result.intScore>=50?'orb warn':'orb danger';
  intEl.style.fontSize='32px';intEl.style.fontWeight='900';

  // Verdict
  const verdEl = document.getElementById('res-verdict');
  const vcard  = document.getElementById('res-verdict-card');
  if(result.pct>=40 && result.intScore>=60){ verdEl.textContent='PASS'; verdEl.style.color='var(--grn)'; vcard.style.borderColor='rgba(0,255,157,.4)'; }
  else if(result.pct<40){ verdEl.textContent='FAIL'; verdEl.style.color='var(--red)'; vcard.style.borderColor='rgba(255,36,68,.4)'; }
  else { verdEl.textContent='REVIEW'; verdEl.style.color='var(--amber)'; vcard.style.borderColor='rgba(255,184,0,.4)'; }
  document.getElementById('res-sub-name').textContent = result.subject;

  // Violations
  const vcnt = document.getElementById('res-vcount');
  vcnt.textContent = result.violations.length+' violations';
  vcnt.className = result.violations.length>5?'badge b-r':result.violations.length>2?'badge b-a':'badge b-g';

  const vlist = document.getElementById('res-vlist');
  if(result.violations.length===0){
    vlist.innerHTML='<div style="color:var(--grn);font-size:11px;font-family:\'JetBrains Mono\',monospace">✓ No violations recorded.</div>';
  } else {
    vlist.innerHTML = result.violations.map(v=>`
      <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(255,36,68,.04);border:1px solid rgba(255,36,68,.15);border-radius:6px;font-size:11px">
        <span>${v.icon||'⚠'}</span>
        <span style="flex:1;color:var(--t1)">${v.text}</span>
        <span class="badge ${v.sev==='crit'||v.sev==='high'?'b-r':v.sev==='med'?'b-a':'b-g'}" style="font-size:8px">${v.sev?.toUpperCase()||'LOW'}</span>
        <span style="font-size:9px;color:var(--t3);font-family:'JetBrains Mono',monospace">${v.t}</span>
      </div>`).join('');
  }

  showV('vResults');
}

// Generate and "send" a PDF report to admin portal
function sendReportToAdmin(result){
  // Generate printable HTML report as blob and store in APP for admin
  const riskScore = 100 - result.intScore;
  const riskLevel = riskScore>=60?'HIGH RISK':riskScore>=30?'MEDIUM RISK':'LOW RISK';
  const riskColor = riskScore>=60?'#ff2444':riskScore>=30?'#ffb800':'#00ff9d';

  const malpractice = result.violations.filter(v=>['crit','high'].includes(v.sev));

  const pdfHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>ProctorAI Exam Report — ${result.name}</title>
<style>
  body{font-family:Arial,sans-serif;margin:0;padding:30px;background:#fff;color:#111}
  .header{background:linear-gradient(135deg,#010305,#0a1420);color:#00f5ff;padding:24px 30px;border-radius:8px;margin-bottom:24px}
  .logo{font-size:28px;font-weight:900;letter-spacing:6px;color:#00f5ff}
  .subtitle{font-size:11px;letter-spacing:3px;color:#5090b8;margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  .card{background:#f5f9ff;border:1px solid #dde8f0;border-radius:8px;padding:14px;text-align:center}
  .card-lbl{font-size:9px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px}
  .card-val{font-size:26px;font-weight:900;color:#0a1420}
  .risk-banner{padding:14px 20px;border-radius:8px;margin-bottom:20px;background:${riskScore>=60?'#fff0f2':riskScore>=30?'#fffbf0':'#f0fff8'};border:2px solid ${riskColor};display:flex;align-items:center;gap:16px}
  .risk-lbl{font-size:22px;font-weight:900;color:${riskColor}}
  .section-title{font-size:13px;font-weight:700;letter-spacing:1px;color:#0a1420;border-bottom:2px solid #00f5ff;padding-bottom:6px;margin:18px 0 10px}
  .vrow{display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:5px;margin-bottom:5px;background:#f8faff;border-left:3px solid ${riskColor}}
  .badge{padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700}
  .b-high{background:#fff0f2;color:#cc1030;border:1px solid #cc1030}
  .b-med{background:#fffbf0;color:#cc8800;border:1px solid #cc8800}
  .b-low{background:#f0fff8;color:#008050;border:1px solid #008050}
  .footer{margin-top:30px;padding-top:14px;border-top:1px solid #dde;font-size:10px;color:#888;display:flex;justify-content:space-between}
  table{width:100%;border-collapse:collapse;margin-bottom:14px}
  th{background:#0a1420;color:#00f5ff;padding:9px 12px;font-size:10px;letter-spacing:1px;text-align:left}
  td{padding:8px 12px;font-size:12px;border-bottom:1px solid #eee}
  tr:nth-child(even) td{background:#f8faff}
</style></head><body>
<div class="header">
  <div class="logo">PROCTOR<span style="color:#b060ff">AI</span></div>
  <div class="subtitle">SMART ONLINE EXAM INTEGRITY SYSTEM — OFFICIAL REPORT</div>
  <div style="margin-top:12px;font-size:11px;color:#5090b8">Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; Submitted By: ${result.name} (${result.id})</div>
</div>

<div class="grid">
  <div class="card"><div class="card-lbl">Score</div><div class="card-val" style="color:#0070cc">${result.score}/${result.total}</div><div style="font-size:11px;color:#888">${result.pct}%</div></div>
  <div class="card"><div class="card-lbl">Integrity</div><div class="card-val" style="color:${result.intScore>=80?'#008050':result.intScore>=50?'#cc8800':'#cc1030'}">${result.intScore}/100</div></div>
  <div class="card"><div class="card-lbl">Violations</div><div class="card-val" style="color:${result.violations.length>3?'#cc1030':'#008050'}">${result.violations.length}</div></div>
  <div class="card"><div class="card-lbl">Risk Score</div><div class="card-val" style="color:${riskColor}">${riskScore}/100</div></div>
</div>

<div class="risk-banner">
  <div style="font-size:36px">${riskScore>=60?'🚨':riskScore>=30?'⚠️':'✅'}</div>
  <div>
    <div class="risk-lbl">${riskLevel}</div>
    <div style="font-size:12px;color:#444;margin-top:2px">Overall Risk Score: <b>${riskScore}/100</b> &nbsp;|&nbsp; Integrity Score: <b>${result.intScore}/100</b> &nbsp;|&nbsp; Auto-Submit: <b>${result.autoSubmit?'Yes (timeout)':'No'}</b></div>
  </div>
</div>

<div class="section-title">STUDENT DETAILS</div>
<table>
  <tr><th>Name</th><th>Student ID</th><th>Subject</th><th>Exam Time</th><th>Verdict</th></tr>
  <tr>
    <td><b>${result.name}</b></td>
    <td>${result.id}</td>
    <td>${result.subject}</td>
    <td>${result.timeSubmitted}</td>
    <td><b style="color:${result.pct>=40&&result.intScore>=60?'#008050':result.pct<40?'#cc1030':'#cc8800'}">${result.pct>=40&&result.intScore>=60?'PASS':result.pct<40?'FAIL':'UNDER REVIEW'}</b></td>
  </tr>
</table>

<div class="section-title">MALPRACTICE & VIOLATIONS (${result.violations.length} events)</div>
${result.violations.length===0
  ? '<div style="padding:12px;background:#f0fff8;border-radius:6px;color:#008050;font-size:12px">✓ No violations detected during the exam session.</div>'
  : result.violations.map(v=>`<div class="vrow"><span style="font-size:16px">${v.icon||'⚠'}</span><span style="flex:1;font-size:12px">${v.text}</span><span class="badge ${v.sev==='crit'||v.sev==='high'?'b-high':v.sev==='med'?'b-med':'b-low'}">${v.sev?.toUpperCase()||'LOW'}</span><span style="font-size:10px;color:#888">${v.t}</span></div>`).join('')
}

${malpractice.length>0?`
<div class="section-title">HIGH-RISK MALPRACTICE SUMMARY</div>
<table>
  <tr><th>Violation</th><th>Severity</th><th>Time</th></tr>
  ${malpractice.map(v=>`<tr><td>${v.icon||'⚠'} ${v.text}</td><td style="color:#cc1030;font-weight:700">${v.sev?.toUpperCase()}</td><td>${v.t}</td></tr>`).join('')}
</table>`:''}

<div class="section-title">RECOMMENDATIONS</div>
<div style="padding:12px;background:#f8faff;border-radius:6px;font-size:12px;line-height:2">
${riskScore>=60?'<b style="color:#cc1030">⚠ HIGH RISK:</b> Manual review strongly recommended. Multiple critical violations detected.<br>':''}
${result.violations.some(v=>v.text.toLowerCase().includes('phone')||v.text.toLowerCase().includes('mobile'))?'• 📱 Mobile phone detected — physical inspection advised.<br>':''}
${result.violations.some(v=>v.text.toLowerCase().includes('tab'))?'• 🖥️ Tab switching detected — possible external resource access.<br>':''}
${result.violations.some(v=>v.text.toLowerCase().includes('person')||v.text.toLowerCase().includes('face'))?'• 👥 Multiple persons / face anomaly — exam condition verification needed.<br>':''}
${result.violations.some(v=>v.text.toLowerCase().includes('paste'))?'• 📋 Copy-paste attempt detected — academic integrity concern.<br>':''}
${riskScore<30?'✓ No significant integrity concerns. Session appears clean.':''}
</div>

<div class="footer">
  <span>ProctorAI — Smart Online Exam Integrity System</span>
  <span>Report ID: RPT-${Date.now()}</span>
  <span>Confidential — Admin Eyes Only</span>
</div>
</body></html>`;

  // Store in APP for admin to access
  const reportEntry = {
    ...result, riskScore, riskLevel, pdfHtml, reportId:'RPT-'+Date.now(),
    receivedAt: new Date().toLocaleTimeString()
  };
  APP.adminReports = APP.adminReports || [];
  APP.adminReports.push(reportEntry);
  persistReports(); // FIX 8: keep reports across refreshes

  // Push live alert to admin feed
  pushFeed(`📨 Report received: ${result.name} — Risk: ${riskLevel} (${riskScore}/100)`,'info');

  // If admin reports tab exists, refresh it
  if(document.getElementById('tab-reports')){ renderReports(); }
}

function downloadMyReport(){
  const last = (APP.completedExams||[]).slice(-1)[0];
  if(!last){ showAlert('No Report','No exam report available.'); return; }
  const r = (APP.adminReports||[]).find(x=>x.name===last.name) || last;
  buildRealPDF(r); // FIX 11: real PDF
}

function goHomeFromResults(){
  APP.answers={};APP.violations=[];APP.intScore=100;APP.tabCnt=0;APP.pasteCnt=0;APP.currentQ=0;APP.timeLeft=3600;
  if(APP.timerId)clearInterval(APP.timerId);
  showV('vAuth');
  switchRole('student');
}

function retakeExamFlow(){
  APP.answers={};APP.violations=[];APP.intScore=100;APP.tabCnt=0;APP.pasteCnt=0;APP.currentQ=0;APP.timeLeft=3600;
  if(APP.timerId)clearInterval(APP.timerId);
  showV('vSetup');
}

// ═══════════════════════════════════════════════
//  ADMIN INIT
// ═══════════════════════════════════════════════
async function initAdmin(){
  // Pull fresh data from server if available
  const [serverExams, serverStudents, serverReports] = await Promise.all([
    apiFetch('GET','/exams'),
    apiFetch('GET','/students'),
    apiFetch('GET','/reports'),
  ]);
  if(serverExams && serverExams.length){
    APP.exams = serverExams; persistExams();
  }
  if(serverStudents && serverStudents.length){
    serverStudents.forEach(s=>{
      if(!APP.students.find(x=>x.id===s.id)){
        APP.students.push({id:s.id,name:s.name,dept:s.dept||'General',score:s.intScore||100,viol:s.violations?.length||0,status:s.status||'active',vlist:s.violations?.map(v=>v.text)||[]});
      }
    });
    persistStudents();
  }
  if(serverReports && serverReports.length){
    APP.adminReports = serverReports; persistReports();
  }
  updateTopStats();
  renderDashboard();
  renderExamList();
  renderStuTable();
  initMessages();
  renderRegisteredStudents();
  document.getElementById('nb-msg').style.display='';
  startAdminLoop();
  ensureAdminStream().then(()=>{ getOrCreateMasterVid(); });
}

function gotoTab(tab){
  APP.adminTab=tab;
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id==='tab-'+tab));
  if(tab==='monitor')renderMonitorGrid();
  if(tab==='analytics')initCharts();
  if(tab==='reports'){renderReports();renderRegisteredStudents();}
}

// ── DASHBOARD ──
function renderDashboard(){
  updateTopStats();
  // Violations list
  const dv=document.getElementById('dash-viols');dv.innerHTML='';
  APP.students.flatMap(s=>s.vlist.map(v=>({n:s.name,v,st:s.status}))).slice(0,7).forEach(item=>{
    const col=item.st==='flagged'?'var(--red)':item.st==='suspicious'?'var(--amber)':'var(--t2)';
    dv.innerHTML+=`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(17,34,54,.4);font-size:11px;animation:slideR .3s ease">
      <span style="color:${col};font-weight:600;white-space:nowrap;font-size:11px">${item.n.split(' ')[0]}</span>
      <span style="flex:1;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.v}</span>
      <span class="badge ${item.st==='flagged'?'b-r':item.st==='suspicious'?'b-a':'b-g'}" style="font-size:8px">${item.st.toUpperCase()}</span></div>`;
  });
  // Overview
  const dov=document.getElementById('dash-overview');dov.innerHTML='';
  APP.students.forEach(s=>{
    const col=s.score>=80?'var(--grn)':s.score>=50?'var(--amber)':'var(--red)';
    dov.innerHTML+=`<div style="display:flex;align-items:center;gap:9px;font-size:11px;margin-bottom:5px">
      <span style="flex:1;font-weight:500">${s.name.split(' ')[0]}</span>
      <div style="width:90px;height:3px;background:var(--bg5);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${s.score}%;background:${col};border-radius:2px;transition:.6s"></div>
      </div>
      <span style="width:34px;text-align:right;color:${col};font-family:'JetBrains Mono',monospace;font-size:10px">${s.score}%</span></div>`;
  });
  // Dashboard quick grid
  const dg=document.getElementById('dash-grid');dg.innerHTML='';
  APP.students.slice(0,4).forEach((st,i)=>renderStudentCard(dg,st,i,true));
}

// ── MONITOR GRID ──
// Global shared hidden video for admin face-detection (avoids creating many streams)
let adminMasterVid = null;

async function ensureAdminStream(){
  // If student already took exam, reuse that stream
  if(APP.stream) return APP.stream;
  // Otherwise request camera fresh for admin monitoring
  try{
    APP.stream = await navigator.mediaDevices.getUserMedia({
      video:{width:640,height:480,facingMode:'user',frameRate:{ideal:30}},
      audio:false
    });
    initAudio();
  }catch(e){ APP.stream=null; }
  return APP.stream;
}

function getOrCreateMasterVid(){
  if(adminMasterVid && adminMasterVid.srcObject) return adminMasterVid;
  adminMasterVid = document.getElementById('admin-master-vid');
  if(!adminMasterVid){
    adminMasterVid = document.createElement('video');
    adminMasterVid.id = 'admin-master-vid';
    adminMasterVid.autoplay = true;
    adminMasterVid.muted = true;
    adminMasterVid.playsInline = true;
    adminMasterVid.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
    document.body.appendChild(adminMasterVid);
  }
  if(APP.stream && adminMasterVid.srcObject !== APP.stream){
    adminMasterVid.srcObject = APP.stream;
    adminMasterVid.play().catch(()=>{});
  }
  return adminMasterVid;
}

function renderMonitorGrid(filter='all'){
  const grid=document.getElementById('monitor-grid');
  if(!grid) return;
  grid.innerHTML='';
  const list=filter==='all'?APP.students:APP.students.filter(s=>s.status===filter);
  const cntEl=document.getElementById('live-cnt');
  if(cntEl) cntEl.textContent=list.length;
  // Stop any existing canvas loops before rebuilding
  APP._monitorLoopActive = false;
  setTimeout(()=>{ APP._monitorLoopActive=true; }, 100);
  list.forEach((st)=>renderStudentCard(grid,st,APP.students.indexOf(st),false));
}

function renderStudentCard(container,st,idx,mini=false){
  const col = st.score>=80?'var(--grn)':st.score>=50?'var(--amber)':'var(--red)';
  const cls = st.status==='flagged'?'flagged':st.status==='suspicious'?'susp':'';
  const pfx = mini?'d':'m';
  const canId = `sc-${pfx}-${idx}`;
  const vidId = `sv-${pfx}-${idx}`;

  const div=document.createElement('div');
  div.className=`stu-card ${cls}${APP.adminSel===idx?' active-sel':''}`;
  div.onclick=()=>selectStudent(idx);
  div.innerHTML=`
    <div class="stu-cam-cell" id="scc-${pfx}-${idx}">
      <video id="${vidId}" autoplay muted playsinline
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.92"></video>
      <canvas id="${canId}" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
      <div class="stu-hud">
        <div class="stu-hud-tl"></div><div class="stu-hud-tr"></div>
        <div class="stu-hud-bl"></div><div class="stu-hud-br"></div>
      </div>
      <div class="stu-cam-overlay">
        <span class="badge ${st.status==='flagged'?'b-r':st.status==='suspicious'?'b-a':'b-g'}" style="font-size:8px">${st.status.toUpperCase()}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:${col}">${st.score}%</span>
      </div>
      <div style="position:absolute;top:5px;right:5px;display:flex;align-items:center;gap:4px;
        background:rgba(0,0,0,.7);border-radius:3px;padding:2px 6px;
        font-family:'JetBrains Mono',monospace;font-size:8px;color:var(--red)">
        <span style="width:5px;height:5px;background:var(--red);border-radius:50%;
          box-shadow:0 0 5px var(--red);animation:blink .6s infinite;display:inline-block"></span>REC
      </div>
    </div>
    <div class="stu-info-cell">
      <div class="stu-name-cell">${st.name}</div>
      <div class="stu-meta-cell"><span>${st.id}</span><span id="stu-vcount-${idx}">${st.viol} violations</span></div>
      <div class="int-bar"><div class="int-bar-fill" id="stu-ibar-${idx}" style="width:${st.score}%;background:${col}"></div></div>
      <div class="stu-vtags">${st.vlist.slice(0,2).map(v=>`<span class="vtag">${v}</span>`).join('')}</div>
    </div>`;
  container.appendChild(div);

  // Attach video stream after DOM insertion
  setTimeout(()=>attachVideoToCard(vidId, canId, st, idx, mini), 80);
}

async function attachVideoToCard(vidId, canId, st, idx, mini){
  // Ensure we have a stream
  if(!APP.stream) await ensureAdminStream();
  const vid = document.getElementById(vidId);
  const can = document.getElementById(canId);
  if(!vid || !can) return;

  if(APP.stream){
    // FIX 4: each card gets its OWN MediaStream wrapper around the same video track
    // so reassigning srcObject on one element doesn't affect all others
    try{
      const tracks = APP.stream.getVideoTracks();
      const cardStream = tracks.length
        ? new MediaStream([tracks[0]])   // independent object, same underlying track
        : APP.stream;                    // fallback if no video tracks
      vid.srcObject = cardStream;
      await vid.play();
      await new Promise(res=>{
        if(vid.readyState>=2){ res(); return; }
        vid.onloadeddata = res;
        setTimeout(res, 2000);
      });
      startCardFaceLoop(vid, can, st, idx, mini);
    }catch(e){
      vid.style.display='none';
      runSimCanvasLoop(can, st, mini);
    }
  } else {
    vid.style.display='none';
    runSimCanvasLoop(can, st, mini);
  }
}

// Per-card face detection loop with proper cleanup
function startCardFaceLoop(vid, can, st, idx, mini){
  const loopKey = `loop_${can.id}`;
  APP[loopKey] = true; // each card has its own loop flag

  const loop = async()=>{
    if(!APP[loopKey] || !document.getElementById(can.id)) return;
    if(can.offsetWidth === 0){ setTimeout(()=>requestAnimationFrame(loop), 500); return; }

    // Sync canvas dimensions to its displayed size
    const rect = can.getBoundingClientRect();
    if(rect.width > 0 && (can.width !== Math.round(rect.width) || can.height !== Math.round(rect.height))){
      can.width = Math.round(rect.width);
      can.height = Math.round(rect.height);
    }

    const dets = await detectFaces(vid);
    drawAdminFaceOverlay(can, vid, dets, st, mini);

    // Update live integrity bar from real violations
    const ibar = document.getElementById(`stu-ibar-${idx}`);
    if(ibar) ibar.style.width = st.score+'%';

    setTimeout(()=>requestAnimationFrame(loop), mini ? 800 : 500);
  };
  requestAnimationFrame(loop);
}

// Simulated canvas loop for when no stream
function runSimCanvasLoop(can, st, mini){
  const loop=()=>{
    if(!document.getElementById(can.id)) return;
    drawSimCanvas(can, st);
    setTimeout(()=>requestAnimationFrame(loop), mini ? 1000 : 600);
  };
  requestAnimationFrame(loop);
}

// Admin-specific face overlay with more detailed HUD
function drawAdminFaceOverlay(can, vid, dets, st, mini=false){
  if(!can || !vid || vid.readyState < 2) return;
  const W = can.width || can.offsetWidth || 210;
  const H = can.height || can.offsetHeight || 157;
  if(W===0||H===0) return;
  const ctx = can.getContext('2d');

  // Draw video frame
  ctx.drawImage(vid, 0, 0, W, H);

  // Overlay dark vignette
  const vgrd = ctx.createRadialGradient(W/2,H/2,H*.2,W/2,H/2,H*.8);
  vgrd.addColorStop(0,'rgba(0,0,0,0)');vgrd.addColorStop(1,'rgba(0,0,0,.35)');
  ctx.fillStyle=vgrd; ctx.fillRect(0,0,W,H);

  if(!dets || dets.length===0){
    // No face warning
    ctx.strokeStyle='rgba(255,36,68,.8)'; ctx.lineWidth=2;
    ctx.strokeRect(2,2,W-4,H-4);
    ctx.fillStyle='rgba(0,0,0,.8)'; ctx.fillRect(0,H-20,W,20);
    ctx.fillStyle='#ff2444'; ctx.font=`${mini?8:10}px JetBrains Mono`;
    ctx.fillText('⚠ NO FACE DETECTED', 7, H-6);
    // Update student status
    if(APP.stream && !st._noFaceWarn){
      st._noFaceWarn = setTimeout(()=>{
        if(st.viol!==undefined) st.viol++;
        if(!st.vlist) st.vlist=[];
        st.vlist.unshift('No face detected');
        st._noFaceWarn=null;
      }, 3000);
    }
    return;
  }

  // Clear no-face timer if face found
  if(st._noFaceWarn){ clearTimeout(st._noFaceWarn); st._noFaceWarn=null; }

  // Scale detections to canvas
  if(!APP.faceApiReady) return;
  const dims = faceapi.matchDimensions(can, {width:W,height:H}, true);
  const resized = faceapi.resizeResults(dets, dims);

  resized.forEach((det, i)=>{
    const box = det.detection.box;
    const conf = (det.detection.score*100).toFixed(1);
    const isMain = i===0;
    const col = isMain ? '#00f5ff' : '#ff2444';

    ctx.shadowColor = col; ctx.shadowBlur = isMain?10:5;
    ctx.strokeStyle = col; ctx.lineWidth = isMain ? 2 : 1.5;

    // Corner brackets
    const cs = mini ? 8:13;
    [[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].forEach(([cx,cy],k)=>{
      const sx=k%2?-1:1, sy=k<2?1:-1;
      ctx.beginPath(); ctx.moveTo(cx,cy+sy*cs); ctx.lineTo(cx,cy); ctx.lineTo(cx+sx*cs,cy); ctx.stroke();
    });
    ctx.shadowBlur=0;

    // Confidence label
    ctx.fillStyle='rgba(0,0,0,.85)'; ctx.fillRect(box.x, box.y-16, isMain?95:125, 14);
    ctx.fillStyle=col; ctx.font=`${mini?8:9}px JetBrains Mono`;
    ctx.fillText(isMain?`STUDENT ${conf}%`:'⚠ UNKNOWN PERSON', box.x+4, box.y-4);

    // Facial landmarks
    if(det.landmarks && isMain && !mini){
      ctx.fillStyle='rgba(0,245,255,.65)';
      det.landmarks.positions.forEach(pt=>{
        ctx.beginPath(); ctx.arc(pt.x,pt.y,1.5,0,Math.PI*2); ctx.fill();
      });
    }

    // Gaze direction arrow on main face
    if(isMain && det.landmarks){
      const g = estimateGaze(det.landmarks);
      const le = det.landmarks.getLeftEye();
      const re = det.landmarks.getRightEye();
      const ex=(le[0].x+re[3].x)/2, ey=(le[0].y+re[3].y)/2;
      const gazeMap={CENTER:[0,0],LEFT:[-22,0],RIGHT:[22,0],UP:[0,-15]};
      const [gx,gy]=gazeMap[g]||[0,0];
      ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex+gx,ey+gy);
      ctx.strokeStyle='rgba(0,245,255,.7)'; ctx.lineWidth=2;
      ctx.shadowColor='rgba(0,245,255,.5)'; ctx.shadowBlur=4; ctx.stroke();
      ctx.shadowBlur=0;

      // Gaze label
      if(!mini && g!=='CENTER'){
        ctx.fillStyle='rgba(255,184,0,.85)'; ctx.fillRect(box.x, box.y+box.height+2, 70, 13);
        ctx.fillStyle='#000'; ctx.font='8px JetBrains Mono';
        ctx.fillText(`GAZE: ${g}`, box.x+3, box.y+box.height+12);
      }
    }

    // Expression
    if(det.expressions && isMain && !mini){
      const exprs = det.expressions;
      const top = Object.entries(exprs).sort((a,b)=>b[1]-a[1])[0];
      const exprColors={neutral:'#00f5ff',happy:'#00ff9d',sad:'#ffb800',fearful:'#ffb800',surprised:'#ffb800',angry:'#ff2444',disgusted:'#ff2444'};
      const ecol = exprColors[top[0]]||'#00f5ff';
      ctx.fillStyle='rgba(0,0,0,.8)'; ctx.fillRect(box.x+box.width-85, box.y-16, 85, 14);
      ctx.fillStyle=ecol; ctx.font='8px JetBrains Mono';
      ctx.fillText(`${top[0].toUpperCase().slice(0,9)} ${(top[1]*100).toFixed(0)}%`, box.x+box.width-83, box.y-5);
    }
  });

  // Multi-person alert
  if(resized.length>1){
    ctx.fillStyle='rgba(255,36,68,.15)'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(255,36,68,.8)'; ctx.lineWidth=3; ctx.strokeRect(2,2,W-4,H-4);
    ctx.fillStyle='rgba(255,36,68,.95)'; ctx.fillRect(0,H-22,W,22);
    ctx.fillStyle='#fff'; ctx.font='bold 10px JetBrains Mono';
    ctx.fillText(`⚠ ${resized.length} PERSONS DETECTED`, 7, H-7);
  }

  // AI confidence bar at bottom
  if(!mini && dets.length>0){
    const conf = dets[0].detection.score;
    const barW = W * conf;
    ctx.fillStyle='rgba(0,0,0,.5)'; ctx.fillRect(0,H-4,W,4);
    const bgrad=ctx.createLinearGradient(0,0,barW,0);
    bgrad.addColorStop(0,'rgba(0,245,255,.8)');bgrad.addColorStop(1,'rgba(0,255,157,.8)');
    ctx.fillStyle=bgrad; ctx.fillRect(0,H-4,barW,4);
  }
}

function filterGrid(val){renderMonitorGrid(val);}

// ── SELECT STUDENT ──
function selectStudent(idx){
  APP.adminSel=idx;
  const st=APP.students[idx];
  const dp=document.getElementById('dp');
  dp.classList.add('show');
  document.getElementById('dp-name').textContent=st.name;
  document.getElementById('dp-id').textContent=st.id;
  document.getElementById('dp-int').textContent=st.score+'%';
  document.getElementById('dp-int').style.color=st.score>=80?'var(--grn)':st.score>=50?'var(--amber)':'var(--red)';
  document.getElementById('dp-viol').textContent=st.viol;
  document.getElementById('dp-status').textContent=st.status.toUpperCase();
  document.getElementById('dp-status').style.color=st.status==='flagged'?'var(--red)':st.status==='suspicious'?'var(--amber)':'var(--grn)';

  // Always show video box with real stream or simulation
  const vb=document.getElementById('dp-vid-box');
  const dpv=document.getElementById('dp-vid');
  const dpc=document.getElementById('dp-cvs');
  vb.style.display='block';

  // Stop any previous detail loop
  APP._detailLoopActive=false;
  setTimeout(()=>{ APP._detailLoopActive=true; }, 50);

  if(APP.stream){
    dpv.style.display='block';
    dpv.srcObject=APP.stream;
    dpv.play().catch(()=>{});
    // Start face detection on detail panel
    const detailLoop=async()=>{
      if(!APP._detailLoopActive||!document.getElementById('dp').classList.contains('show'))return;
      const dets=await detectFaces(dpv);
      drawAdminFaceOverlay(dpc,dpv,dets,st,false);
      setTimeout(()=>requestAnimationFrame(detailLoop),400);
    };
    // Works whether video is fresh or already loaded
    if(dpv.readyState>=2){
      requestAnimationFrame(detailLoop);
    } else {
      dpv.onloadeddata=()=>requestAnimationFrame(detailLoop);
      setTimeout(()=>requestAnimationFrame(detailLoop),800);
    }
  } else {
    dpv.style.display='none';
    // Simulated canvas loop for detail
    const simLoop=()=>{
      if(!APP._detailLoopActive||!document.getElementById('dp').classList.contains('show'))return;
      drawSimCanvas(dpc,st);
      setTimeout(()=>requestAnimationFrame(simLoop),500);
    };
    requestAnimationFrame(simLoop);
  }

  if(APP.adminTab==='monitor')renderMonitorGrid();
}

function adminAct(type){
  if(APP.adminSel===null){showAlert('No Student Selected','Please click on a student card first to select them.');return;}
  const st=APP.students[APP.adminSel];
  if(type==='warn'){
    pushFeed(`⚠ Warning sent to ${st.name}`,'warn');
    showAlert('Warning Sent',`Formal warning issued to ${st.name} (${st.id}).`);
    if(socket) socket.emit('admin:action',{action:'warn', sid:st.id});
  } else if(type==='terminate'){
    st.status='flagged';
    if(socket) socket.emit('admin:action',{action:'terminate', sid:st.id});
    pushFeed(`🚫 Session terminated: ${st.name}`,'danger');
    showAlert('Session Terminated',`${st.name}'s exam has been terminated.`);
    renderMonitorGrid();
  } else if(type==='clear'){
    st.status='active'; st.viol=Math.max(0,st.viol-1);
    if(socket) socket.emit('admin:action',{action:'clear', sid:st.id});
    pushFeed(`✓ Flag cleared: ${st.name}`,'safe'); renderMonitorGrid();
  } else if(type==='msg'){gotoTab('messages');openMsgContact(st.id);}
  updateTopStats();
}

// ── EXAM MANAGEMENT ──
function renderExamList(){
  const list=document.getElementById('exam-list');list.innerHTML='';
  APP.exams.forEach(ex=>{
    const row=document.createElement('div');row.className='exam-row';
    row.innerHTML=`
      <div class="exam-icon">📝</div>
      <div class="exam-row-info">
        <div class="exam-row-title">${ex.title}</div>
        <div class="exam-row-meta">
          <span>🔑 <b style="color:var(--cyan)">${ex.code}</b></span>
          <span>📚 ${ex.subject}</span>
          <span>⏱ ${ex.dur}min</span>
          <span>📊 ${ex.marks}marks</span>
          <span>👥 ${ex.students} students</span>
        </div>
        <div style="font-size:10px;color:var(--t3);margin-top:4px;font-family:'JetBrains Mono',monospace">${ex.desc}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
        <span class="badge ${ex.active?'b-g':'b-r'}">${ex.active?'ACTIVE':'INACTIVE'}</span>
        <div class="exam-actions">
          <button class="ea-btn ea-view" onclick="viewExam(${ex.id})">View</button>
          <button class="ea-btn ea-edit" onclick="editExam(${ex.id})">Edit</button>
          <button class="ea-btn ea-toggle" onclick="toggleExam(${ex.id})">${ex.active?'Deactivate':'Activate'}</button>
          <button class="ea-btn ea-del" onclick="deleteExam(${ex.id})">Delete</button>
        </div>
      </div>`;
    list.appendChild(row);
  });
  if(APP.exams.length===0){
    document.getElementById('exam-list').innerHTML=`<div style="text-align:center;padding:40px;color:var(--t3);font-family:'JetBrains Mono',monospace;font-size:12px">No exams created yet. Click CREATE EXAM to get started.</div>`;
  }
}

function openExamModal(editId=null){
  const isEdit=editId!==null;
  document.getElementById('em-title').textContent=isEdit?'EDIT EXAM':'CREATE NEW EXAM';
  document.getElementById('em-sub').textContent=isEdit?'Modify exam settings':'Configure exam settings and proctoring rules';
  document.getElementById('em-editing-id').value=isEdit?editId:'';
  if(isEdit){
    const ex=APP.exams.find(e=>e.id===editId);if(!ex)return;
    document.getElementById('em-etitle').value=ex.title;
    document.getElementById('em-code').value=ex.code;
    document.getElementById('em-dur').value=ex.dur;
    document.getElementById('em-marks').value=ex.marks;
    document.getElementById('em-pass').value=ex.pass;
    document.getElementById('em-desc').value=ex.desc;
  }else{
    document.getElementById('em-etitle').value='';document.getElementById('em-code').value='';
    document.getElementById('em-dur').value=60;document.getElementById('em-marks').value=100;
    document.getElementById('em-pass').value=40;document.getElementById('em-desc').value='';
  }
  document.getElementById('exam-modal').classList.remove('hidden');
}

function saveExam(){
  const title=document.getElementById('em-etitle').value.trim();
  const code=document.getElementById('em-code').value.trim();
  const editingId=document.getElementById('em-editing-id').value;
  if(!title||!code){showAlert('Missing Fields','Please fill in the exam title and exam code.');return;}
  if(!editingId){
    // Check duplicate code
    if(APP.exams.find(e=>e.code===code)){showAlert('Duplicate Code','An exam with this code already exists. Please use a different code.');return;}
    const newEx={
      id:APP.nextExamId++,title,code,
      subject:document.getElementById('em-sub').value,
      dur:parseInt(document.getElementById('em-dur').value)||60,
      marks:parseInt(document.getElementById('em-marks').value)||100,
      pass:parseInt(document.getElementById('em-pass').value)||40,
      desc:document.getElementById('em-desc').value,
      active:true,students:0,
    };
    APP.exams.push(newEx);
    persistExams();
    apiFetch('POST','/exams', newEx).catch(()=>{});
    pushFeed(`📝 New exam created: "${title}"`, 'safe');
    showAlert('Exam Created ✓',`"${title}" has been created successfully.\n\nExam Code: ${code}\n\nShare this code with students to allow access.`);
  }else{
    const ex=APP.exams.find(e=>e.id===parseInt(editingId));
    if(ex){Object.assign(ex,{title,code,subject:document.getElementById('em-sub').value,dur:parseInt(document.getElementById('em-dur').value)||60,marks:parseInt(document.getElementById('em-marks').value)||100,pass:parseInt(document.getElementById('em-pass').value)||40,desc:document.getElementById('em-desc').value});persistExams();apiFetch('PUT',`/exams/${ex.id}`,ex).catch(()=>{});}
    pushFeed(`✏ Exam updated: "${title}"`, 'safe');
    showAlert('Exam Updated ✓',`"${title}" has been updated successfully.`);
  }
  closeModal('exam-modal');renderExamList();
}

function editExam(id){openExamModal(id);}
function deleteExam(id){
  const ex=APP.exams.find(e=>e.id===id);if(!ex)return;
  showAlert('Delete Exam',`Are you sure you want to delete "${ex.title}"?\n\nThis action cannot be undone.`,()=>{
    APP.exams=APP.exams.filter(e=>e.id!==id);persistExams();apiFetch('DELETE',`/exams/${id}`).catch(()=>{});renderExamList();pushFeed(`🗑 Exam deleted: "${ex.title}"`,'danger');
  },'DELETE');
}
function toggleExam(id){
  const ex=APP.exams.find(e=>e.id===id);if(!ex)return;
  ex.active=!ex.active;renderExamList();
  pushFeed(`${ex.active?'✓ Exam activated':'⚠ Exam deactivated'}: "${ex.title}"`,ex.active?'safe':'warn');
}
function viewExam(id){
  const ex=APP.exams.find(e=>e.id===id);if(!ex)return;
  document.getElementById('vem-title').textContent=ex.title;
  document.getElementById('vem-body').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
      <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:13px">
        <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t2);letter-spacing:1.5px;margin-bottom:9px">EXAM DETAILS</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Code:</span><b style="color:var(--cyan)">${ex.code}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Subject:</span><b>${ex.subject}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Duration:</span><b>${ex.dur} minutes</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Total Marks:</span><b>${ex.marks}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Passing:</span><b>${ex.pass}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Students:</span><b>${ex.students}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t2)">Status:</span><b style="color:${ex.active?'var(--grn)':'var(--red)'}">${ex.active?'ACTIVE':'INACTIVE'}</b></div>
        </div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:13px">
        <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t2);letter-spacing:1.5px;margin-bottom:9px">DESCRIPTION</div>
        <p style="color:var(--t1);line-height:1.7">${ex.desc||'No description provided.'}</p>
      </div>
    </div>`;
  document.getElementById('view-exam-modal').classList.remove('hidden');
}

// ── STUDENT MANAGEMENT ──
function renderStuTable(filter='',statusFilter='all'){
  const tbody=document.getElementById('stu-tbody');tbody.innerHTML='';
  const list=APP.students.filter(s=>{
    const matchTxt=!filter||s.name.toLowerCase().includes(filter)||s.id.toLowerCase().includes(filter)||s.dept.toLowerCase().includes(filter);
    const matchSt=statusFilter==='all'||s.status===statusFilter;
    return matchTxt&&matchSt;
  });
  document.getElementById('stu-cnt').textContent=list.length+' students';
  list.forEach(st=>{
    const col=st.score>=80?'var(--grn)':st.score>=50?'var(--amber)':'var(--red)';
    const init=st.name.split(' ').map(n=>n[0]).join('');
    const row=document.createElement('div');row.className='stu-tbl-row';
    row.innerHTML=`
      <div style="display:flex;align-items:center;gap:9px">
        <div class="stu-avatar">${init}</div>
        <div><div style="font-weight:600;font-size:12px">${st.name}</div><div style="font-size:10px;color:var(--t2)">${st.dept}</div></div>
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px">${st.id}</div>
      <div style="font-size:11px;color:var(--t2)">${st.dept.split(' ')[0]}</div>
      <div style="font-weight:700;color:${col};font-family:'JetBrains Mono',monospace;font-size:11px">${st.score}%</div>
      <div style="font-size:11px;color:${st.viol>5?'var(--red)':st.viol>2?'var(--amber)':'var(--t2)'};font-weight:600">${st.viol}</div>
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
        <span class="badge ${st.status==='flagged'?'b-r':st.status==='suspicious'?'b-a':'b-g'}" style="font-size:8px">${st.status.toUpperCase()}</span>
        <button class="ea-btn ea-view" style="font-size:10px;padding:3px 9px" onclick="viewStuDetail('${st.id}')">View</button>
        <button class="ea-btn ea-edit" style="font-size:10px;padding:3px 9px" onclick="selectStudent(${APP.students.indexOf(st)});gotoTab('monitor')">Monitor</button>
      </div>`;
    tbody.appendChild(row);
  });
  if(list.length===0){tbody.innerHTML=`<div style="text-align:center;padding:24px;color:var(--t3);font-family:'JetBrains Mono',monospace;font-size:11px">No students match this filter.</div>`;}
}
function filterStuTable(val){renderStuTable(val,document.getElementById('stu-tbody')?.dataset?.status||'all');}
function filterStuByStatus(val){renderStuTable(document.getElementById('stu-srch')?.value||'',val);}

function openAddStudentModal(){document.getElementById('stu-modal').classList.remove('hidden');}
function saveStudent(){
  const fn=document.getElementById('sm-fn').value.trim();
  const ln=document.getElementById('sm-ln').value.trim();
  const em=document.getElementById('sm-em').value.trim().toLowerCase();
  const sid=document.getElementById('sm-sid').value.trim();
  const dept=document.getElementById('sm-dept').value;
  const pw=document.getElementById('sm-pw').value;
  if(!fn||!ln||!em||!sid||!pw){showAlert('Missing Fields','Please fill all student details.');return;}
  if(pw.length<6){showAlert('Weak Password','Password must be at least 6 characters.');return;}
  if(APP.users.find(u=>u.email===em)){showAlert('Duplicate Email','This email is already registered.');return;}
  const newStu={
    id:sid,name:`${fn} ${ln}`,dept,score:100,viol:0,status:'active',vlist:[]
  };
  APP.students.push(newStu);
  APP.users.push({email:em,pwd:pw,role:'student',name:`${fn} ${ln}`,sid,dept});
  persistStudents(); persistUsers(); // FIX 7
  APP.messages[sid]=[];
  closeModal('stu-modal');renderStuTable();renderMonitorGrid();updateTopStats();
  pushFeed(`✓ Student added: ${fn} ${ln}`,'safe');
  showAlert('Student Added ✓',`${fn} ${ln} has been registered.\n\nID: ${sid}\nEmail: ${em}\nTemp Password: ${pw}`);
  document.getElementById('sm-fn').value='';document.getElementById('sm-ln').value='';
  document.getElementById('sm-em').value='';document.getElementById('sm-sid').value='';
  document.getElementById('sm-pw').value='';
}

function viewStuDetail(sid){
  const st=APP.students.find(s=>s.id===sid);if(!st)return;
  showAlert(`${st.name} — Profile`,
    `STUDENT ID: ${st.id}\nDEPARTMENT: ${st.dept}\nINTEGRITY: ${st.score}%\nVIOLATIONS: ${st.viol}\nSTATUS: ${st.status.toUpperCase()}\n\nViolation Log:\n${st.vlist.length?st.vlist.map(v=>'• '+v).join('\n'):'No violations recorded.'}`);
}

// ── CHARTS ──
let chartsBuilt=false;
function initCharts(){
  if(chartsBuilt)return;chartsBuilt=true;
  const chartCfg={plugins:{legend:{labels:{color:'var(--t2)',font:{family:'JetBrains Mono',size:9}}}},scales:{x:{ticks:{color:'var(--t3)',font:{family:'JetBrains Mono',size:9}},grid:{color:'rgba(17,34,54,.5)'},border:{color:'rgba(17,34,54,.5)'}},y:{ticks:{color:'var(--t3)',font:{family:'JetBrains Mono',size:9}},grid:{color:'rgba(17,34,54,.5)'},border:{color:'rgba(17,34,54,.5)'}}}};
  new Chart(document.getElementById('ch-int').getContext('2d'),{type:'bar',data:{labels:APP.students.map(s=>s.name.split(' ')[0]),datasets:[{label:'Integrity',data:APP.students.map(s=>s.score),backgroundColor:APP.students.map(s=>s.score>=80?'rgba(0,245,255,.3)':s.score>=50?'rgba(255,184,0,.3)':'rgba(255,36,68,.3)'),borderColor:APP.students.map(s=>s.score>=80?'rgba(0,245,255,.8)':s.score>=50?'rgba(255,184,0,.8)':'rgba(255,36,68,.8)'),borderWidth:1.5,borderRadius:4}]},options:{...chartCfg,plugins:{legend:{display:false}},scales:{...chartCfg.scales,y:{...chartCfg.scales.y,max:100}}}});
  new Chart(document.getElementById('ch-vtype').getContext('2d'),{type:'doughnut',data:{labels:['Tab Switch','Copy-Paste','Face Lost','Multi-Person','Phone','Gaze Away'],datasets:[{data:[8,6,4,3,5,7],backgroundColor:['rgba(0,245,255,.5)','rgba(255,36,68,.5)','rgba(255,184,0,.5)','rgba(176,96,255,.5)','rgba(0,255,157,.5)','rgba(255,208,96,.5)'],borderColor:['rgba(0,245,255,.9)','rgba(255,36,68,.9)','rgba(255,184,0,.9)','rgba(176,96,255,.9)','rgba(0,255,157,.9)','rgba(255,208,96,.9)'],borderWidth:1.5}]},options:{plugins:{legend:{labels:{color:'var(--t2)',font:{family:'JetBrains Mono',size:9}},position:'bottom'}}}});
  new Chart(document.getElementById('ch-scatter').getContext('2d'),{type:'scatter',data:{datasets:[{label:'Students',data:APP.students.map(s=>({x:s.viol,y:s.score})),backgroundColor:'rgba(0,245,255,.7)',pointRadius:8,pointHoverRadius:11}]},options:{...chartCfg,plugins:{legend:{display:false}},scales:{x:{...chartCfg.scales.x,title:{display:true,text:'Violations',color:'var(--t2)',font:{family:'JetBrains Mono',size:9}}},y:{...chartCfg.scales.y,title:{display:true,text:'Integrity %',color:'var(--t2)',font:{family:'JetBrains Mono',size:9}}}}}});
  const labels=['10:00','10:05','10:10','10:15','10:20','10:25','10:30','10:35','10:40'];
  new Chart(document.getElementById('ch-timeline').getContext('2d'),{type:'line',data:{labels,datasets:[{label:'Violations',data:[1,3,4,3,7,5,8,7,9],borderColor:'rgba(255,36,68,.8)',backgroundColor:'rgba(255,36,68,.1)',tension:.4,fill:true,pointRadius:4,pointBackgroundColor:'rgba(255,36,68,.9)'},{label:'Warnings',data:[0,1,1,2,2,3,3,4,5],borderColor:'rgba(255,184,0,.8)',backgroundColor:'rgba(255,184,0,.1)',tension:.4,fill:true,pointRadius:4,pointBackgroundColor:'rgba(255,184,0,.9)'}]},options:{...chartCfg}});
}

// ── MESSAGING ──
function initMessages(){
  const contacts=document.getElementById('msg-contacts');contacts.innerHTML='';
  APP.students.forEach(st=>{
    const msgs=APP.messages[st.id]||[];
    const unread=msgs.filter(m=>m.from==='student').length;
    const div=document.createElement('div');
    div.className=`msg-contact${APP.msgContact===st.id?' sel':''}`;
    div.onclick=()=>openMsgContact(st.id);
    div.innerHTML=`<div class="mc-av">${st.name.split(' ').map(n=>n[0]).join('')}</div><div style="flex:1;min-width:0"><div class="mc-name">${st.name}</div><div class="mc-last">${msgs.length?msgs[msgs.length-1].text:'No messages'}</div></div>${unread?`<span class="mc-badge">${unread}</span>`:''}`;
    contacts.appendChild(div);
  });
  document.getElementById('nb-msg').textContent=APP.students.reduce((a,s)=>(APP.messages[s.id]||[]).filter(m=>m.from==='student').length+a,0);
}

function openMsgContact(sid){
  APP.msgContact=sid;const st=APP.students.find(s=>s.id===sid);
  document.getElementById('msg-main').innerHTML=`
    <div class="msg-main-hdr">
      <div class="mc-av">${st.name.split(' ').map(n=>n[0]).join('')}</div>
      <div>
        <div style="font-weight:600;font-size:13px">${st.name}</div>
        <div style="font-size:10px;color:var(--t2);display:flex;align-items:center;gap:5px">
          <span class="sdot ${st.status==='active'?'sd-g':st.status==='flagged'?'sd-r':'sd-a'}" style="width:5px;height:5px"></span>
          ${st.status.toUpperCase()} · ${st.id} · INT: ${st.score}%
        </div>
      </div>
      <span class="badge ${st.status==='flagged'?'b-r':'b-g'}" style="margin-left:auto">INTEGRITY: ${st.score}%</span>
    </div>
    <div class="msg-bubbles" id="msg-bubs-${sid}"></div>
    <div class="msg-input-row">
      <textarea class="msg-inp" id="msg-inp-${sid}" placeholder="Type a message to ${st.name.split(' ')[0]}…"></textarea>
      <button class="msg-send-btn" onclick="sendMsg('${sid}')">SEND ↑</button>
    </div>`;
  renderMsgBubbles(sid);
  document.getElementById(`msg-inp-${sid}`).addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg(sid);}});
  initMessages();
}

function renderMsgBubbles(sid){
  const wrap=document.getElementById(`msg-bubs-${sid}`);if(!wrap)return;
  wrap.innerHTML='';
  (APP.messages[sid]||[]).forEach(msg=>{
    const d=document.createElement('div');d.className=`msg-b ${msg.from==='admin'?'sent':'recv'}`;
    d.innerHTML=`${msg.text}<div class="msg-b-time">${msg.from==='admin'?'You (Admin)':'Student'} · ${msg.time}</div>`;
    wrap.appendChild(d);
  });
  wrap.scrollTop=wrap.scrollHeight;
}

function sendMsg(sid){
  const inp=document.getElementById(`msg-inp-${sid}`);const text=inp.value.trim();if(!text)return;
  const time=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(!APP.messages[sid])APP.messages[sid]=[];
  APP.messages[sid].push({from:'admin',text,time});
  inp.value='';renderMsgBubbles(sid);
  // POST to server for real-time delivery to student
  apiFetch('POST',`/messages/${sid}`,{text}).catch(()=>{});
  pushFeed(`✉ Message sent to ${APP.students.find(s=>s.id===sid)?.name}`,'safe');
  if(Math.random()>.45){
    setTimeout(()=>{
      const replies=['Understood, thank you.','OK, acknowledged.','I see, continuing now.','Thank you for letting me know.'];
      APP.messages[sid].push({from:'student',text:replies[Math.floor(Math.random()*replies.length)],time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})});
      if(APP.msgContact===sid)renderMsgBubbles(sid);
      initMessages();
    },2000+Math.random()*3000);
  }
}

// ── AI REPORT ──
async function genReport(){
  const btn=document.getElementById('rep-btn'),out=document.getElementById('rep-out');
  btn.disabled=true;btn.textContent='⬡ Analyzing…';
  out.innerHTML='<div class="rep-typing"><span class="rt"></span><span class="rt"></span><span class="rt"></span></div><div style="font-size:10px;color:var(--t3);margin-top:6px">Claude AI is analyzing violation patterns and generating integrity assessment…</div>';
  const summary=APP.students.map(s=>`${s.name} (${s.id}): Integrity ${s.score}%, ${s.viol} violations, Status: ${s.status.toUpperCase()}. Issues: ${s.vlist.join(', ')||'None'}`).join('\n');
  const flagged=APP.students.filter(s=>s.status==='flagged');
  const suspicious=APP.students.filter(s=>s.status==='suspicious');
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-sonnet-4-20250514',max_tokens:1000,
        system:`You are ProctorAI's AI integrity analyst. Generate a concise, well-structured exam integrity report using plain text. Sections: EXECUTIVE SUMMARY, RISK TABLE (each student with PASS/REVIEW/FAIL), VIOLATION PATTERNS, TOP RECOMMENDATIONS. Professional, precise, max 250 words.`,
        messages:[{role:'user',content:`EXAM SESSION REPORT\n\nExam: Computer Science Final Exam\nDate: ${new Date().toLocaleDateString()}\nStudents: ${APP.students.length} | Flagged: ${flagged.length} | Suspicious: ${suspicious.length}\nAvg Integrity: ${Math.round(APP.students.reduce((a,b)=>a+b.score,0)/APP.students.length)}%\n\nStudent Data:\n${summary}\n\nGenerate a complete integrity analysis report with specific recommendations.`}]
      })
    });
    if(!res.ok)throw new Error('API '+res.status);
    const data=await res.json();
    const text=data.content?.[0]?.text||'No response.';
    out.innerHTML=`<div style="color:var(--violet);font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1px;margin-bottom:8px;border-bottom:1px solid var(--bdr);padding-bottom:6px">⬡ CLAUDE AI REPORT — ${new Date().toLocaleTimeString()}</div><div style="white-space:pre-wrap;line-height:1.85;color:var(--t0);font-size:10px">${text}</div>`;
  }catch(e){
    const avgInt=Math.round(APP.students.reduce((a,b)=>a+b.score,0)/APP.students.length);
    out.innerHTML=`<div style="color:var(--amber);font-family:'JetBrains Mono',monospace;font-size:9px;margin-bottom:6px">⬡ AUTO REPORT (API offline)</div><div style="white-space:pre-wrap;font-size:10px;line-height:1.85;color:var(--t1)">EXECUTIVE SUMMARY\nSession shows ${flagged.length} flagged and ${suspicious.length} suspicious students. Average integrity ${avgInt}%.\n\nRISK TABLE\n${APP.students.map(s=>`${s.name.padEnd(15)} INT:${String(s.score).padStart(3)}% V:${s.viol} → ${s.score<50||s.status==='flagged'?'FAIL':s.status==='suspicious'?'REVIEW':'PASS'}`).join('\n')}\n\nRECOMMENDATIONS\n• Manual review required for: ${flagged.map(s=>s.name).join(', ')||'None'}\n• Re-exam consideration for score <50%\n• Policy review for tab-switch violations</div>`;
  }
  btn.disabled=false;btn.textContent='⬡ GENERATE AI REPORT';
}

// ── REGISTERED STUDENTS (for admin reports tab) ──
function renderRegisteredStudents(){
  const listEl = document.getElementById('reg-stu-list');
  if(!listEl) return;
  const students = APP.users.filter(u=>u.role==='student');
  // Merge with active exam students
  const allStu = [...students];
  APP.students.forEach(s=>{
    if(!allStu.find(u=>u.sid===s.id)){
      allStu.push({name:s.name,sid:s.id,dept:s.dept,email:s.id.toLowerCase()+'@student.edu',_active:true,status:s.status});
    }
  });

  const cntEl=document.getElementById('reg-count');
  if(cntEl) cntEl.textContent=allStu.length+' registered';

  listEl.innerHTML = allStu.map(u=>{
    const active = APP.students.find(s=>s.id===u.sid);
    const status = active ? active.status : 'registered';
    const statusBadge = status==='flagged'?'b-r':status==='suspicious'?'b-a':status==='active'?'b-g':'b-c';
    const loginTime = active ? `<span style="color:var(--grn);font-size:10px">● LIVE NOW</span>` : `<span style="color:var(--t3);font-size:10px">${u._lastLogin||'Not in session'}</span>`;
    return `<div class="stu-tbl-row" style="grid-template-columns:2fr 1fr 1fr 1fr 1fr">
      <div style="display:flex;align-items:center;gap:9px">
        <div class="stu-avatar">${u.name.charAt(0)}</div>
        <div><div style="font-size:12px;font-weight:600">${u.name}</div><div style="font-size:10px;color:var(--t2)">${u.email||''}</div></div>
      </div>
      <span style="font-size:11px;font-family:'JetBrains Mono',monospace">${u.sid||'—'}</span>
      <span style="font-size:11px;color:var(--t1)">${u.dept||'—'}</span>
      <span class="badge ${statusBadge}" style="font-size:8px;justify-self:start">${status.toUpperCase()}</span>
      ${loginTime}
    </div>`;
  }).join('');
}

// ── REPORTS (auto-received from students) ──
function renderReports(){
  const container = document.getElementById('reports-container');
  if(!container) return;
  const reports = APP.adminReports||[];

  // Update badge
  const nbRep = document.getElementById('nb-reports');
  if(nbRep){ nbRep.textContent=reports.length; nbRep.style.display=reports.length?'':'none'; }
  const repCount = document.getElementById('rep-count');
  if(repCount) repCount.textContent=reports.length;

  if(reports.length===0){
    container.innerHTML=`<div style="text-align:center;padding:40px;color:var(--t3);font-family:'JetBrains Mono',monospace;font-size:12px">
      <div style="font-size:48px;margin-bottom:12px;opacity:.3">📨</div>
      <div>No reports received yet.</div>
      <div style="font-size:10px;margin-top:6px;color:var(--t4)">Reports appear here automatically when students submit their exams.</div>
    </div>`;
    return;
  }

  container.innerHTML = reports.slice().reverse().map((r,i)=>{
    const riskColor = r.riskScore>=60?'var(--red)':r.riskScore>=30?'var(--amber)':'var(--grn)';
    const riskBadge = r.riskScore>=60?'b-r':r.riskScore>=30?'b-a':'b-g';
    const verdictCol = r.pct>=40&&r.intScore>=60?'var(--grn)':r.pct<40?'var(--red)':'var(--amber)';
    return `<div style="background:linear-gradient(135deg,var(--bg2),var(--bg3));border:1px solid var(--bdr);border-radius:12px;padding:16px 20px;margin-bottom:12px;animation:slideR .3s ease" id="report-card-${i}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,rgba(0,245,255,.1),rgba(176,96,255,.1));border:1px solid var(--bdr2);display:flex;align-items:center;justify-content:center;font-family:'Orbitron',monospace;font-weight:700;font-size:16px;color:var(--cyan)">${r.name.charAt(0)}</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--t0)">${r.name}</div>
            <div style="font-size:10px;color:var(--t2);font-family:'JetBrains Mono',monospace">${r.id} &nbsp;·&nbsp; ${r.subject}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="badge ${riskBadge}" style="font-size:9px">⚡ ${r.riskLevel}</span>
          <span style="font-size:10px;color:var(--t3);font-family:'JetBrains Mono',monospace">${r.receivedAt||r.timeSubmitted}</span>
        </div>
      </div>

      <!-- Stats row -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px">
        <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:10px;text-align:center">
          <div style="font-size:8px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">SCORE</div>
          <div style="font-family:'Orbitron',monospace;font-size:18px;font-weight:700;color:var(--cyan)">${r.score}/${r.total}</div>
          <div style="font-size:9px;color:var(--t2)">${r.pct}%</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:10px;text-align:center">
          <div style="font-size:8px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">INTEGRITY</div>
          <div style="font-family:'Orbitron',monospace;font-size:18px;font-weight:700;color:${r.intScore>=80?'var(--grn)':r.intScore>=50?'var(--amber)':'var(--red)'}">${r.intScore}</div>
          <div style="font-size:9px;color:var(--t2)">/100</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:10px;text-align:center">
          <div style="font-size:8px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">RISK SCORE</div>
          <div style="font-family:'Orbitron',monospace;font-size:18px;font-weight:700;color:${riskColor}">${r.riskScore}</div>
          <div style="font-size:9px;color:var(--t2)">/100</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:10px;text-align:center">
          <div style="font-size:8px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">VIOLATIONS</div>
          <div style="font-family:'Orbitron',monospace;font-size:18px;font-weight:700;color:${r.violations.length>3?'var(--red)':r.violations.length>0?'var(--amber)':'var(--grn)'}">${r.violations.length}</div>
          <div style="font-size:9px;color:var(--t2)">events</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:7px;padding:10px;text-align:center">
          <div style="font-size:8px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">VERDICT</div>
          <div style="font-family:'Orbitron',monospace;font-size:14px;font-weight:700;color:${verdictCol}">${r.pct>=40&&r.intScore>=60?'PASS':r.pct<40?'FAIL':'REVIEW'}</div>
        </div>
      </div>

      <!-- Violations quick list -->
      ${r.violations.length>0?`
      <div style="margin-bottom:12px">
        <div style="font-size:9px;color:var(--t2);font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:6px">MALPRACTICE DETECTED:</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${r.violations.map(v=>`<span style="background:rgba(255,36,68,.06);border:1px solid rgba(255,36,68,.2);border-radius:4px;padding:3px 8px;font-size:10px;color:var(--t1)">${v.icon||'⚠'} ${v.text}</span>`).join('')}
        </div>
      </div>`:'<div style="padding:7px;background:rgba(0,255,157,.05);border-radius:5px;font-size:10px;color:var(--grn);margin-bottom:10px;font-family:\'JetBrains Mono\',monospace">✓ No violations detected</div>'}

      <!-- Actions -->
      <div style="display:flex;gap:8px">
        <button onclick="viewFullReport(${reports.length-1-i})" style="padding:7px 16px;border-radius:5px;border:1px solid var(--cyan3);background:rgba(0,245,255,.06);color:var(--cyan);font-size:11px;font-weight:700;cursor:pointer;transition:.2s;font-family:'Exo 2',sans-serif" onmouseover="this.style.background='var(--cyan)';this.style.color='#000'" onmouseout="this.style.background='rgba(0,245,255,.06)';this.style.color='var(--cyan)'">👁 VIEW FULL REPORT</button>
        <button onclick="downloadReportIdx(${reports.length-1-i})" style="padding:7px 16px;border-radius:5px;border:1px solid var(--grn3);background:rgba(0,255,157,.06);color:var(--grn);font-size:11px;font-weight:700;cursor:pointer;transition:.2s;font-family:'Exo 2',sans-serif" onmouseover="this.style.background='var(--grn)';this.style.color='#000'" onmouseout="this.style.background='rgba(0,255,157,.06)';this.style.color='var(--grn)'">📥 DOWNLOAD PDF</button>
        ${r.riskScore>=60?`<button onclick="flagStudent('${r.name}')" style="padding:7px 16px;border-radius:5px;border:1px solid var(--red3);background:rgba(255,36,68,.06);color:var(--red);font-size:11px;font-weight:700;cursor:pointer;transition:.2s;font-family:'Exo 2',sans-serif" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(255,36,68,.06)';this.style.color='var(--red)'">🚨 FLAG FOR REVIEW</button>`:''}
      </div>
    </div>`;
  }).join('');
}

function viewFullReport(idx){
  const r = (APP.adminReports||[])[idx];
  if(!r||!r.pdfHtml){ showAlert('No Report','Report data not available.'); return; }
  const w = window.open('','_blank','width=900,height=700,scrollbars=yes');
  if(w){ w.document.write(r.pdfHtml); w.document.close(); }
  else { showAlert('Pop-up Blocked','Please allow pop-ups to view the full report.'); }
}

function downloadReportIdx(idx){
  const r = (APP.adminReports||[])[idx];
  if(!r){ showAlert('No Report','Report not available.'); return; }
  buildRealPDF(r); // FIX 10: real PDF
}

function exportAllReports(){
  const reports = APP.adminReports||[];
  if(!reports.length){ showAlert('No Reports','No reports to export yet.'); return; }
  reports.forEach((r,i)=>{ setTimeout(()=>buildRealPDF(r), i*400); }); // FIX 12
}

function flagStudent(name){
  const st = APP.students.find(s=>s.name===name);
  if(st){ st.status='flagged'; updateTopStats(); pushFeed(`🚨 ${name} flagged by admin after report review`,'danger'); }
  showAlert('Student Flagged',`${name} has been flagged for review.`);
  renderReports();
}

// ── ADMIN LOOP ──
let admLoopStarted=false;
function startAdminLoop(){
  if(admLoopStarted)return;admLoopStarted=true;
  setInterval(()=>{
    // Redraw sim canvases for all grids
    APP.students.forEach((st,i)=>{
      [`sc-m-${i}`,`sc-d-${i}`].forEach(cid=>{
        const c=document.getElementById(cid);
        if(c&&!(i===0&&APP.stream))drawSimCanvas(c,st);
      });
    });
    // Random alert events
    if(Math.random()<.09){
      const st=APP.students[Math.floor(Math.random()*APP.students.length)];
      const evts=[
        {msg:`⚠ Gaze deviation: ${st.name}`,col:'warn'},
        {msg:`🚨 Tab switch detected: ${st.name}`,col:'danger'},
        {msg:`⚠ Audio spike: ${st.name}`,col:'warn'},
        {msg:`📱 Mobile phone detected: ${st.name}`,col:'danger'},
        {msg:`⬡ Face confidence drop: ${st.name}`,col:'warn'},
        {msg:`👥 Multi-person check: ${st.name}`,col:'danger'},
        {msg:`📱 Electronic device detected: ${st.name}`,col:'danger'},
        {msg:`⌚ Smartwatch visible: ${st.name}`,col:'warn'},
      ];
      const ev=evts[Math.floor(Math.random()*evts.length)];
      pushFeed(ev.msg,ev.col);
      if(ev.col==='danger'&&Math.random()<.2&&st.status==='active'){
        st.status='suspicious';st.viol++;updateTopStats();
      }
    }
    // Refresh reports badge
    const nbRep=document.getElementById('nb-reports');
    if(nbRep&&APP.adminReports?.length){ nbRep.textContent=APP.adminReports.length; nbRep.style.display=''; }
  },2000);
}

function updateTopStats(){
  const act=APP.students.filter(s=>s.status==='active').length;
  const flg=APP.students.filter(s=>s.status==='flagged').length;
  const avg=APP.students.length?Math.round(APP.students.reduce((a,b)=>a+b.score,0)/APP.students.length):0;
  const wrn=APP.students.filter(s=>s.status==='suspicious').length;
  const reg=APP.users.filter(u=>u.role==='student').length;
  const updates=[
    {ids:['sc-act','aq-act'],val:act,cls:'cyan'},
    {ids:['sc-int'],val:avg+'%',cls:'safe'},
    {ids:['sc-wrn'],val:wrn,cls:'warn'},
    {ids:['sc-flg','aq-flg'],val:flg,cls:'danger'},
    {ids:['sc-reg'],val:reg,cls:'violet'},
  ];
  updates.forEach(u=>u.ids.forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.textContent=u.val;el.className=u.cls||'';}
  }));
  const nbLive=document.getElementById('nb-live');
  if(nbLive)nbLive.textContent=APP.students.length;
}

let admAlerts=0;
function pushFeed(msg,type){
  admAlerts++;
  document.getElementById('aq-alr').textContent=admAlerts;
  document.getElementById('adm-alr-cnt').textContent=admAlerts;
  const feed=document.getElementById('adm-feed');if(!feed)return;
  const cols={warn:'var(--amber)',danger:'var(--red)',safe:'var(--grn)',info:'var(--cyan)'};
  const d=document.createElement('div');d.className='feed-it';
  d.innerHTML=`<div class="feed-dot" style="background:${cols[type]||cols.info}"></div><div><div class="feed-txt">${msg}</div><div class="feed-time">${new Date().toLocaleTimeString()}</div></div>`;
  feed.prepend(d);while(feed.children.length>60)feed.removeChild(feed.lastChild);
}

// ════════════════════════════════════════════════════════════════════
//  FIX 9: REAL jsPDF BUILDER  (replaces HTML blob download)
// ════════════════════════════════════════════════════════════════════
function buildRealPDF(r){
  // Graceful fallback if jsPDF somehow failed to load
  if(typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined'){
    if(r && r.pdfHtml){
      const blob = new Blob([r.pdfHtml], {type:'text/html'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ProctorAI_${(r.name||'Report').replace(/\s/g,'_')}.html`;
      a.click();
    } else { showAlert('PDF Error','jsPDF library not loaded and no fallback HTML available.'); }
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });

  const riskScore = r.riskScore != null ? r.riskScore : (100 - (r.intScore||0));
  const riskLevel = riskScore>=60?'HIGH RISK':riskScore>=30?'MEDIUM RISK':'LOW RISK';
  const riskRGB   = riskScore>=60?[204,16,48]:riskScore>=30?[204,136,0]:[0,128,80];
  const verdict   = (r.pct>=40 && r.intScore>=60) ? 'PASS' : r.pct<40 ? 'FAIL' : 'UNDER REVIEW';

  // ── Dark header band ──
  doc.setFillColor(1,3,5);
  doc.rect(0,0,210,36,'F');
  doc.setTextColor(0,245,255);
  doc.setFont('helvetica','bold');
  doc.setFontSize(22);
  doc.text('PROCTOR', 12, 15);
  doc.setTextColor(176,96,255);
  doc.text('AI', 12 + doc.getTextWidth('PROCTOR') + 1, 15);
  doc.setTextColor(80,144,184);
  doc.setFont('helvetica','normal');
  doc.setFontSize(7.5);
  doc.text('SMART ONLINE EXAM INTEGRITY SYSTEM — OFFICIAL REPORT', 12, 22);
  doc.text(`Generated: ${new Date().toLocaleString()}   |   By: ${r.name||'—'} (${r.id||r.sid||'—'})`, 12, 28);

  // ── 4-column score tiles ──
  let y = 44;
  const tiles = [
    { lbl:'SCORE',     val:`${r.score||0}/${r.total||10}`, sub:`${r.pct||0}%`,    rgb:[0,112,204]   },
    { lbl:'INTEGRITY', val:`${r.intScore||0}`,            sub:'/ 100',            rgb:r.intScore>=80?[0,128,80]:r.intScore>=50?[204,136,0]:[204,16,48] },
    { lbl:'VIOLATIONS',val:`${(r.violations||[]).length}`,sub:'events',           rgb:(r.violations||[]).length>3?[204,16,48]:[0,128,80] },
    { lbl:'RISK',      val:`${riskScore}`,                sub:riskLevel,          rgb:riskRGB        },
  ];
  const cw=46, ch=24, cx=12, gap=3;
  tiles.forEach((t,i)=>{
    const tx = cx + i*(cw+gap);
    doc.setFillColor(245,249,255); doc.roundedRect(tx,y,cw,ch,2,2,'F');
    doc.setFillColor(...t.rgb); doc.rect(tx,y,cw,3,'F');
    doc.setFontSize(7); doc.setTextColor(120,120,120); doc.setFont('helvetica','normal');
    doc.text(t.lbl, tx+cw/2, y+10, {align:'center'});
    doc.setFontSize(13); doc.setTextColor(...t.rgb); doc.setFont('helvetica','bold');
    doc.text(t.val, tx+cw/2, y+18, {align:'center'});
    doc.setFontSize(7); doc.setTextColor(120,120,120); doc.setFont('helvetica','normal');
    doc.text(t.sub, tx+cw/2, y+23, {align:'center'});
  });
  y += ch + 8;

  // ── Student Details table ──
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(10,20,32);
  doc.text('STUDENT DETAILS', 12, y); y += 3;
  doc.setDrawColor(...riskRGB); doc.setLineWidth(0.4); doc.line(12,y,198,y); y += 2;
  doc.autoTable({
    startY: y,
    head: [['Name','Student ID','Subject','Submitted','Verdict']],
    body: [[r.name||'—', r.id||r.sid||'—', r.subject||'—', r.timeSubmitted||'—', verdict]],
    headStyles: { fillColor:[10,20,32], textColor:[0,245,255], fontSize:8, fontStyle:'bold' },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,250,255] },
    margin: { left:12, right:12 },
    theme: 'grid',
  });
  y = doc.lastAutoTable.finalY + 6;

  // ── Violations table ──
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(10,20,32);
  doc.text(`VIOLATIONS (${(r.violations||[]).length} events)`, 12, y); y += 3;
  doc.setLineWidth(0.4); doc.line(12,y,198,y); y += 2;

  if(!(r.violations||[]).length){
    doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.setTextColor(0,128,80);
    doc.text('✓ No violations detected during this exam session.', 14, y+7);
    y += 14;
  } else {
    doc.autoTable({
      startY: y,
      head: [['#','Violation','Severity','Time']],
      body: (r.violations||[]).map((v,i)=>[i+1, `${v.icon||'⚠'} ${v.text}`, v.sev?.toUpperCase()||'LOW', v.t||'—']),
      headStyles: { fillColor:[10,20,32], textColor:[0,245,255], fontSize:8, fontStyle:'bold' },
      bodyStyles: { fontSize:8 },
      columnStyles: { 0:{cellWidth:10}, 2:{cellWidth:22}, 3:{cellWidth:28} },
      alternateRowStyles: { fillColor:[255,248,250] },
      margin: { left:12, right:12 },
      theme: 'striped',
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Recommendations ──
  if(y < 248){
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(10,20,32);
    doc.text('RECOMMENDATIONS', 12, y); y += 3;
    doc.setLineWidth(0.4); doc.line(12,y,198,y); y += 4;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(60,60,80);
    const recs = [];
    if(riskScore>=60)     recs.push('• HIGH RISK: Manual review strongly recommended. Multiple critical violations.');
    if((r.violations||[]).some(v=>(v.text||'').toLowerCase().includes('phone')))  recs.push('• Mobile phone detected — physical inspection advised.');
    if((r.violations||[]).some(v=>(v.text||'').toLowerCase().includes('tab')))    recs.push('• Tab-switching detected — possible access to external resources.');
    if((r.violations||[]).some(v=>(v.text||'').toLowerCase().includes('person'))) recs.push('• Multiple persons detected — exam-condition verification required.');
    if((r.violations||[]).some(v=>(v.text||'').toLowerCase().includes('paste')))  recs.push('• Copy-paste blocked — academic integrity concern.');
    if(!recs.length) recs.push('• No significant integrity concerns. Session appears clean.');
    recs.forEach(rec=>{ doc.text(rec, 14, y, {maxWidth:182}); y+=6; });
  }

  // ── Footer ──
  doc.setFillColor(1,3,5); doc.rect(0,283,210,14,'F');
  doc.setTextColor(80,144,184); doc.setFontSize(7); doc.setFont('helvetica','normal');
  doc.text('ProctorAI — Smart Online Exam Integrity System', 12, 291);
  doc.text(`Report ID: ${r.reportId||'RPT-'+Date.now()}`, 105, 291, {align:'center'});
  doc.text('Confidential — Admin Eyes Only', 198, 291, {align:'right'});

  doc.save(`ProctorAI_Report_${(r.name||'Student').replace(/\s/g,'_')}_${r.reportId||Date.now()}.pdf`);
}

// ── MODAL & ALERT ──
function closeModal(id){document.getElementById(id).classList.add('hidden');}

let alertCb=null,alertConfirmCb=null;
function showAlert(title,body,confirmCb=null,confirmText='OK'){
  document.getElementById('mo-title').textContent=title;
  document.getElementById('mo-body').textContent=body;
  document.getElementById('mo-ok').textContent=confirmText;
  alertConfirmCb=confirmCb;
  document.getElementById('alert-mo').classList.remove('hidden');
}
function closeAlert(){
  document.getElementById('alert-mo').classList.add('hidden');
  if(alertConfirmCb){ alertConfirmCb(); alertConfirmCb=null; }
}

// Kick off face-api loading
loadFaceAPI();
