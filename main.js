// 处理作品集筛选
document.querySelectorAll('.filter-btn').forEach(button => {
    button.addEventListener('click', () => {
        const filter = button.dataset.filter;
        
        // 更新按钮状态
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        button.classList.add('active');
        
        // 筛选作品
        document.querySelectorAll('.portfolio-item').forEach(item => {
            if (filter === 'all' || item.dataset.category === filter) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    });
});

// 处理技能条动画
function animateSkillBars() {
    document.querySelectorAll('.progress-bar').forEach(bar => {
        const percent = bar.dataset.percent;
        bar.style.setProperty('--percent', `${percent}%`);
    });
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    animateSkillBars();
});

// 处理表单提交
document.querySelector('.contact-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    // 这里添加表单提交逻辑
    alert('消息已发送！');
}); 