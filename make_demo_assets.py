from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, math, random, zipfile, io
from pathlib import Path
random.seed(5)
root=Path(__file__).parent
A=root/'assets'; A.mkdir(exist_ok=True)
fonts='/usr/share/fonts/truetype/dejavu'
bold=lambda n:ImageFont.truetype(f'{fonts}/DejaVuSansCondensed-Bold.ttf',n)
regular=lambda n:ImageFont.truetype(f'{fonts}/DejaVuSans.ttf',n)
serif=lambda n:ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',n)
W,H=720,1080
c_cream='#f3e6c8';c_gold='#e8b77d';c_white='#fff7e9'
def bg(top=(17,20,35),bottom=(88,52,67)):
 im=Image.new('RGB',(W,H)); px=im.load()
 for y in range(H):
  k=y/H;col=tuple(int(top[i]*(1-k)+bottom[i]*k) for i in range(3))
  for x in range(W): px[x,y]=col
 return im

def panel_city(im,bounds,sky='#222336',glow='#c77761',night=True):
 d=ImageDraw.Draw(im)
 x0,y0,x1,y1=bounds
 d.rectangle(bounds,fill=sky,outline=c_gold,width=5)
 # moon
 d.ellipse((x1-150,y0+55,x1-50,y0+155),fill=glow)
 for b in range(23):
  xx=x0+15+b*33+random.randint(-12,12)
  h=random.randint(90,int((y1-y0)*.8))
  y=y1-h
  d.rectangle((xx,y,xx+random.randint(25,57),y1),fill=random.choice(['#10121d','#191826','#272334']))
  for yy in range(y+18,y1-5,23):
   for wx in range(xx+8,xx+32,14):
    if random.random()>.47:d.rectangle((wx,yy,wx+5,yy+8),fill=random.choice(['#e9ab70','#f8d3a2','#8e6971']))
 d.line((x0,y1-22,x1,y1-22),fill='#a5685c',width=6)

def speech(d,xy,text,width=580,fill='#eee3d1',ink='#262431',fontsize=25):
 x,y=xy
 lines=[];current=''
 for word in text.split():
  test=(current+' '+word).strip()
  if d.textbbox((0,0),test,font=bold(fontsize))[2]>width and current:lines.append(current);current=word
  else:current=test
 lines.append(current)
 lineh=fontsize+9;ht=30+len(lines)*lineh
 d.rounded_rectangle((x,y,x+width+34,y+ht),radius=12,fill=fill)
 for i,line in enumerate(lines):d.text((x+17,y+13+i*lineh),line,font=bold(fontsize),fill=ink)

def footer(d,p):
 d.text((43,1030),f'COMICS  /  THE LAST SIGNAL',font=bold(14),fill='#dac9b9')
 d.text((658,1030),str(p).zfill(2),font=bold(17),fill='#dac9b9')

pages=[]
# Cover
im=bg((13,20,31),(92,58,66));d=ImageDraw.Draw(im)
panel_city(im,(28,310,692,990),sky='#303044')
d=ImageDraw.Draw(im)
d.rectangle((28,28,692,286),fill='#0f1526',outline=c_gold,width=4)
d.text((57,53),'A COMICS ORIGINAL',font=bold(18),fill=c_gold)
d.text((52,102),'THE LAST',font=bold(88),fill=c_cream)
d.text((52,192),'SIGNAL',font=bold(88),fill=c_gold)
d.polygon([(275,920),(315,778),(328,740),(356,712),(385,740),(401,792),(452,920)],fill='#090c19')
d.ellipse((320,696,389,768),fill='#090c19')
d.line((358,768,358,931),fill='#080a12',width=50)
d.text((45,1007),'A SHORT STORY ABOUT THE THINGS WE LEAVE BEHIND',font=bold(16),fill=c_white)
pages.append(im)
# page2
im=bg((15,21,30),(51,35,47));d=ImageDraw.Draw(im)
d.rectangle((28,28,692,1048),fill='#121826',outline='#b48477',width=4)
panel_city(im,(46,46,674,460),sky='#23263d',glow='#e0a672')
d=ImageDraw.Draw(im)
speech(d,(60,65),'THE CITY HAD BEEN SILENT FOR TWELVE YEARS.',width=500,fontsize=24)
d.rectangle((46,489,674,994),fill='#2f2a37',outline='#e8b77d',width=4)
for i in range(35):
 x=random.randrange(46,674);y=random.randrange(500,983)
 d.line((x,y,x+35,y-14),fill=random.choice(['#54414b','#70505a','#98707a']),width=2)
d.line((120,880,560,760),fill='#e1ae86',width=8)
d.line((120,890,560,770),fill='#111622',width=5)
speech(d,(66,516),'UNTIL THE NIGHT IT ANSWERED.',width=450,fontsize=27)
footer(d,2);pages.append(im)
# Page 3
im=bg((17,18,31),(44,50,66));d=ImageDraw.Draw(im)
d.rectangle((28,28,692,1048),outline='#c48e73',width=4)
d.rectangle((46,46,674,484),fill='#202b40',outline=c_gold,width=4)
# console
for i in range(30):
 y=76+i*12;v=math.sin(i*.64)*28+math.sin(i*.2)*19
 d.line((102,y,310+v,y),fill=random.choice(['#d5a26e','#af796c','#5e8390']),width=3)
d.rectangle((389,102,625,429),fill='#0d1225',outline='#8aa6a9',width=4)
d.text((410,132),'SIGNAL FOUND',font=bold(24),fill='#b3dabf')
d.text((410,189),'SOURCE',font=regular(17),fill='#b7a7b2')
d.text((410,228),'UNKNOWN',font=bold(24),fill=c_gold)
speech(d,(56,510),'ONE MESSAGE. NO SENDER. NO FREQUENCY.',width=550,fontsize=25)
d.rectangle((46,650,674,994),fill='#111625',outline=c_gold,width=4)
d.text((99,710),'COME',font=bold(95),fill=c_white)
d.text((99,825),'HOME.',font=bold(95),fill=c_gold)
footer(d,3);pages.append(im)
# Page4
im=bg((31,24,34),(71,44,55));d=ImageDraw.Draw(im)
d.rectangle((28,28,692,1048),outline=c_gold,width=4)
panel_city(im,(46,46,674,563),sky='#252638',glow='#ba786f')
d=ImageDraw.Draw(im)
# silhouette
points=[(280,553),(288,438),(318,387),(359,377),(396,406),(411,464),(446,555)]
d.polygon(points,fill='#0b101d');d.ellipse((310,326,404,418),fill='#0b101d')
d.line((359,375,361,551),fill='#090e19',width=75)
speech(d,(62,75),'SOME VOICES ARE NEVER REALLY LOST.',width=540,fontsize=25)
d.rectangle((46,592,674,994),fill='#181b2a',outline=c_gold,width=4)
d.text((86,653),'THE STATIC BROKE.',font=bold(41),fill=c_cream)
d.text((86,721),'A SINGLE LIGHT',font=bold(39),fill=c_cream)
d.text((86,787),'TURNED ON.',font=bold(41),fill=c_gold)
d.line((85,882,616,882),fill='#b38c74',width=4)
footer(d,4);pages.append(im)
# Page 5
im=bg((17,22,31),(90,58,64));d=ImageDraw.Draw(im)
panel_city(im,(28,28,692,880),sky='#2b3048',glow='#e9b779')
d=ImageDraw.Draw(im)
d.polygon([(185,857),(280,710),(324,653),(356,690),(392,760),(452,857)],fill='#101422')
d.ellipse((305,634,382,716),fill='#101422')
d.polygon([(400,857),(455,711),(497,670),(545,719),(570,857)],fill='#181724')
d.ellipse((461,637,535,713),fill='#181724')
d.rectangle((28,888,692,1020),fill='#171725',outline=c_gold,width=4)
d.text((60,905),'EVERY SIGNAL',font=bold(57),fill=c_white)
d.text((60,961),'HAS A SOURCE.',font=bold(46),fill=c_gold)
d.text((606,1025),'THE END',font=bold(13),fill=c_white)
pages.append(im)
with zipfile.ZipFile(A/'demo.cbz','w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for i,page in enumerate(pages,1):
  stream=io.BytesIO();page.save(stream,format='JPEG',quality=79,optimize=True)
  z.writestr(f'{i:03d}.jpg',stream.getvalue())
# App icon
for s in [180,192,512]:
 im=Image.new('RGB',(s,s),'#15141c');d=ImageDraw.Draw(im)
 def xy(a):return round(a*s/512)
 for off,alpha in [(0,'#5d4550'),(22,'#a37769'),(43,'#e8b77d')]:
  x=xy(112+off);y=xy(110+off*.5)
  d.rounded_rectangle((x,y,x+xy(190),y+xy(245)),radius=xy(23),outline=alpha,width=xy(13))
 d.line((xy(194),xy(163),xy(194),xy(390)),fill='#e8b77d',width=xy(10))
 im.save(A/f'icon-{s}.png')
print('demo', (A/'demo.cbz').stat().st_size)
